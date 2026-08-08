"""本地音素识别边车。音频进，原始 eSpeak IPA 串出——就这一件事。

刻意做成哑服务：**不做**归一化、不查词典、不跟目标词比对。那些都在 Node 侧
（server/src/analysis/），因为本项目的 IPA 集合定义在那边的 phones.ts，这份知识只该有
一处；将来换识别模型，Node 侧一行不用改。

跟 vosk 的根本区别：这个模型没有词表约束。它不会把你的音往真词上靠——你把 /n/ 发成
/l/，它就写 /l/。这正是"什么都说对"的解药。

启动：npm run asr（仓库根），或 uv run --project asr-service uvicorn main:app --port 30032
"""

import io
import logging
import os

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Request
from transformers import AutoModelForCTC, AutoProcessor

MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft"
SAMPLE_RATE = 16000

# 推理前在前后各补这么多静音。**实测**：
# 不补的话短音频的首尾音素会被 CTC 吃掉——blue→"b l"（丢 uː）、day→"eɪ"（丢 d）、
# cup→"k a"（丢 p）。补 100ms 三个都回来了，补 300ms 没有额外收益，所以不多补。
PAD_MS = 100

# 上限挡住手滑传上来的长音频：这是练单词/短语的工具，十几秒足够，
# 再长只会让一次请求卡住整个服务（模型是单实例，没有并发队列）。
MAX_SECONDS = 30

# **必须自己配一次 handler**：只 getLogger 拿到的 logger 在 uvicorn 下一行都打不出来
# （uvicorn 只给自己那几个 logger 配 handler，root 上没有，这个 logger 就没处输出）。
# 一直如此，原来那句「模型已加载」从来没人见过。现在要紧了：模型从哪儿来、
# 是不是正在下 1.2GB，恰恰是启动窗口里最该看见的东西——界面上那条
# 「回来看终端」指的就是这里。
#
# **level 给 WARNING，只把自己这个 logger 抬到 INFO。** 原来这里是
# `basicConfig(level=INFO)`——那是给 **root** 设的，于是每个第三方库的 INFO 一起开闸：
# httpx 每发一个请求打一行 `HTTP Request: HEAD https://huggingface.co/...`，
# 缓存命中的启动也有三十来行英文 URL，把本该只有三句中文的窗口整个淹掉。
logging.basicConfig(level=logging.WARNING, format="%(message)s")

log = logging.getLogger("asr-service")
log.setLevel(logging.INFO)
app = FastAPI(title="pronunciation phoneme ASR")

_state: dict = {}


# 从哪儿取模型。`.env` 里写 MODEL_SOURCE=hf 或 modelscope 可以钉死；
# 不写就按 resolve_model() 里的顺序自己挑。
# （`.env` 能管到这个进程，是因为 npm run asr 走 scripts/asr.mjs 那层包装。）
MODEL_SOURCE = os.environ.get("MODEL_SOURCE", "").strip().lower()


def _hf_cache_hit() -> bool:
    """本地 HuggingFace 缓存里已经有了吗。

    **这一步必须在最前面。** 否则已经下过 1.2GB 的人换上新版本后，
    会因为"先试 ModelScope"而往另一个缓存目录里把同一个模型再下一遍。
    """
    try:
        from huggingface_hub import try_to_load_from_cache
        hit = try_to_load_from_cache(MODEL, "config.json")
        return isinstance(hit, str)
    except Exception:
        return False


def _from_modelscope() -> str | None:
    """整仓下到 ModelScope 的缓存，返回本地目录；失败返回 None。"""
    try:
        from modelscope.hub.snapshot_download import snapshot_download
        return snapshot_download(MODEL)
    except Exception as e:  # noqa: BLE001 —— 任何失败都只是"这条路不通"，换下一条
        log.warning("ModelScope 取模型失败：%s", e)
        return None


def resolve_model() -> str:
    """给 from_pretrained 用的 repo id 或本地目录。

    ── 顺序为什么是这个 ──

    1. **本地已有就用本地**：不联网、不重下。老用户升级到这版不该付任何代价。
    2. **要下载时优先 ModelScope**：同一个模型（facebook/wav2vec2-lv-60-espeak-cv-ft），
       实测四轮吞吐 15–59 MB/s，而 huggingface.co 是 0.69–1.35、hf-mirror 是 0.09–3.06。
       1.2GB 按 0.7 MB/s 要二十多分钟，按 56 MB/s 是二十来秒——这是"装得上"和
       "装不上"的差别，而这个工具的使用者都是中文母语者。
    3. **ModelScope 不通就回落 HuggingFace**：镜像站不是上游，可能下架、可能挂。
       回落这条路上 HF_ENDPOINT 照样有效（.env 里可以指到 hf-mirror）。

    注意 ModelScope **不能**靠 HF_ENDPOINT 接管：它的 /resolve/ 和 /api/models/
    用 curl 打都是 200，看着兼容，但 huggingface_hub 实际会 LocalEntryNotFoundError
    ——元信息对不上。所以只能走它自己的 SDK。
    """
    cached = _hf_cache_hit()
    if cached and MODEL_SOURCE != "modelscope":
        log.info("本地缓存里已有模型，不重新下载")
        return MODEL
    if cached:
        # 钉死了 modelscope 就照办（`.env` 里那句是承诺，不能偷偷换源），
        # **但不能再说「不重新下载」**：本地那份缓存是 HuggingFace 的，
        # ModelScope 有自己的缓存目录，那边没有的话这一趟照样要下 1.2GB。
        # 原来这两句是分开的——先无条件打「不重新下载」，再落到 ModelScope 那条路，
        # 于是钉死这个源的人一边看着那句话、一边看着进度条跑。
        log.info("本地缓存里有模型，但 MODEL_SOURCE=modelscope 钉死了源，"
                 "仍从 ModelScope 取；那边没缓存的话还要下一次")
    else:
        # ── 这句必须有 ──
        #
        # 界面上那条「等了一分半还没连上」明确让人**回来看这个窗口**，说
        # 「里面有一行 [asr] 开头的说明——首次启动多半是还在下模型」。
        # 而在这句之前，第一次启动的人在这儿看到的只有一串英文进度条：
        # 浏览器**承诺了一段说明，窗口里却没有**。
        #
        # 措辞上说"获取"不说"下载"：MODEL_SOURCE=modelscope 时它可能命中
        # ModelScope 自己的缓存，那时一个字节都不会下，说"开始下载"就是假话。
        log.info("模型不在本地缓存里，开始获取——第一次要下约 1.2GB，"
                 "下面那些进度条就是它；下过一次以后每次启动只要十几秒")

    if MODEL_SOURCE == "hf":
        log.info("按 MODEL_SOURCE=hf 取模型")
        return MODEL
    if MODEL_SOURCE == "modelscope":
        path = _from_modelscope()
        if path is None:
            raise RuntimeError("MODEL_SOURCE=modelscope 但 ModelScope 取不到模型")
        return path
    return _from_modelscope() or MODEL


def _load(src: str, offline: bool) -> None:
    # do_phonemize=False 跳过 phonemizer 后端初始化：那个后端只用于"文本→音素"编码，
    # 这里只做"音频→音素"解码，用不上；而它在 Windows 上还要另装 eSpeak-NG 二进制。
    _state["processor"] = AutoProcessor.from_pretrained(
        src, do_phonemize=False, local_files_only=offline)
    model = AutoModelForCTC.from_pretrained(src, local_files_only=offline)
    model.eval()
    _state["model"] = model


@app.on_event("startup")
def load_model() -> None:
    src = resolve_model()
    # **先按离线加载一次。** 不带 local_files_only 的话，from_pretrained 即使全部命中
    # 缓存也要回 hub 逐个文件核对 etag——实测三十来次 HEAD/GET，还包括去翻这个仓库的
    # safetensors 转换 PR。代价不只是刷屏：白等一两秒，而且**断网就起不来**，
    # 尽管缓存里什么都有。
    #
    # 失败了再联网走一次原来那条路：`_hf_cache_hit()` 只看 config.json，
    # 缓存不全（下到一半、或者只有 ModelScope 那份）时离线这趟会抛 OSError
    # （LocalEntryNotFoundError 是它的子类），这时行为跟以前一模一样。
    try:
        _load(src, offline=True)
    except OSError:
        _load(src, offline=False)
    log.info("模型已加载：%s（来源 %s）", MODEL, src if src != MODEL else "HuggingFace")


def to_mono_16k(raw: bytes) -> np.ndarray:
    data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != SAMPLE_RATE:
        n = int(round(len(mono) * SAMPLE_RATE / sr))
        if n <= 1:
            raise ValueError("音频太短")
        mono = np.interp(
            np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono
        ).astype("float32")
    return mono


@app.get("/health")
def health() -> dict:
    return {"ok": "model" in _state, "model": MODEL}


@app.post("/recognize")
async def recognize(request: Request) -> dict:
    if "model" not in _state:
        raise HTTPException(503, "模型还在加载")

    raw = await request.body()
    if not raw:
        raise HTTPException(400, "请求体是空的")

    try:
        audio = to_mono_16k(raw)
    except Exception as e:  # soundfile 对坏音频抛的异常类型不止一种，一律当成坏输入
        raise HTTPException(400, f"这段音频解不开：{e}") from e

    if len(audio) == 0:
        raise HTTPException(400, "音频里一个采样点都没有")
    if len(audio) > MAX_SECONDS * SAMPLE_RATE:
        raise HTTPException(413, f"音频超过 {MAX_SECONDS}s")

    pad = np.zeros(int(SAMPLE_RATE * PAD_MS / 1000), dtype="float32")
    padded = np.concatenate([pad, audio, pad])

    processor, model = _state["processor"], _state["model"]
    with torch.no_grad():
        logits = model(**processor(padded, sampling_rate=SAMPLE_RATE, return_tensors="pt")).logits
    ipa = processor.batch_decode(torch.argmax(logits, dim=-1))[0]

    return {
        "ipa": ipa,
        "phones": phone_confidences(logits[0]),
        "seconds": round(len(audio) / SAMPLE_RATE, 3),
    }


def phone_confidences(logits) -> list[dict]:
    """逐音素置信度：CTC 折叠出的每一段，取该段内该 token 概率的均值。

    为什么值得要：模型对**没把握**的音同样会给出一个具体答案，看上去跟确凿的检出一模一样。
    实测：真检出普遍 0.76 以上，
    而那几个已知的误报——water 的 ɑː(0.31)、cat 的 eː(0.33)——全在 0.35 以下。
    有了这个数，Node 侧就能把"确凿的错"和"模型自己都拿不准"分开，不用去替
    cot-caught 合并这类方言差异写特例规则。

    返回的顺序跟 batch_decode 出来的 token 顺序一致，Node 侧按位置对应。
    """
    model = _state["model"]
    processor = _state["processor"]
    vocab = {v: k for k, v in processor.tokenizer.get_vocab().items()}
    pad = model.config.pad_token_id

    probs = torch.softmax(logits, dim=-1)
    ids = torch.argmax(logits, dim=-1).tolist()

    out: list[dict] = []
    prev = None
    run: list[float] = []

    def flush() -> None:
        if prev is not None and prev != pad and run:
            out.append({"ipa": vocab[prev], "conf": round(sum(run) / len(run), 4)})

    for t, i in enumerate(ids):
        if i != prev:
            flush()
            run = []
        if i != pad:
            run.append(probs[t, i].item())
        prev = i
    flush()
    return out
