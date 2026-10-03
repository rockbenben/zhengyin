import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Space, Typography, message } from 'antd';
import { AudioOutlined, SwapOutlined } from '@ant-design/icons';
import { Link } from 'react-router';
import { api } from '../api';
import type { AsrResult, Contrast, PronounceResult } from '../types';
import { blobToClip, clipToWavBlob, type Clip } from '../lib/wav';
import { detectEndOfSpeech, type Endpointer } from '../lib/endpoint';
import { phonetic } from '../lib/notation';
import { localAppUrl } from '../lib/brand';
import { onPlayFailure } from '../lib/playback';
import { isNoise, isWrong, UNSURE } from '../lib/align';
import Markdown from 'react-markdown';
import OverprintStrip from './OverprintStrip';
import Notice from './Notice';
import PlaceRuler from './PlaceRuler';
import Verdicts from './Verdicts';
import { checkModelAvailability, contrastAll, type ModelAvailability, type ContrastVerdict } from '../lib/asr';

interface Props {
  /** 这次录音要比对的目标词（单词，不是整句短语） */
  target: string;
  /**
   * 这个词所属的词条。短语页逐词录音时 target 是其中一个词，而那个词本身可能不是词条——
   * 评测流水和复习卡都要记在词条上，不能记在裸词上。
   */
  entry: string;
  /** 标准音 URL；没有音频文件（MW/TTS 都没拿到）时为 null，对比播放按钮会禁用 */
  referenceUrl: string | null;
  /**
   * 评测出结果时回调。复习页靠它自动打分——那一页不该让人自己评"记得没记得"，
   * 工具能逐音素客观测出来，自评反而不准（"什么都说对，其实我也不知道到底怎么样"）。
   * 测不出来（边车没起、降级到 vosk、没听出音）时传 null：那种情况不能打分。
   */
  onResult?: (r: PronounceResult | null) => void;
  /**
   * 操作说明给多少。
   * full  = 词条页：连"它凭什么说得出第几个音发成了什么""录音不出这台机器"一起讲清楚
   * brief = 复习页：只留操作那一句。一次复习要过七八张卡，
   *         每张都摊开同样五行灰字，读到第三遍它就只是噪音了。
   */
  hint?: 'full' | 'brief';
}

const micSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * 麦克风用不了，是**因为地址不对**还是浏览器真的不支持。
 *
 * `navigator.mediaDevices` 只在安全上下文里暴露：localhost 算，`http://192.168.x.x`
 * 不算。所以从局域网地址打开时它直接是 undefined——而说「当前浏览器不支持录音」
 * 是误诊。这条会真撞上：服务监听 0.0.0.0，手机或另一台电脑打开时查词/音素/笔记
 * 都正常，唯独录音被挡，那时必须说清是地址的问题。
 */
const insecureOrigin = typeof window !== 'undefined' && window.isSecureContext === false;

/** 边车没就绪时每隔多久再问一次 */
const POLL_MS = 2000;
/**
 * 问多久之后放弃、改口说"没启动"。
 * 模型冷启动实测十几秒；首次要下 1.2GB，那种情况下更久，但那一次终端里有下载进度可看。
 * 90 秒够覆盖正常的冷启动，又不至于让真的没装 uv 的人一直等一个不会来的东西。
 */
const GIVE_UP_MS = 90_000;

/** 浏览器降噪的开关。存在 localStorage：它是采集端的偏好，跟服务端无关 */
export const NS_KEY = 'pron:noise-suppression';

// 信噪比低于这个数就提示。20dB 是个宽松的界：安静房间里对着麦克风说话通常在 30dB 以上，
// 20dB 以下basically 是"背景里一直有东西在响"。
const LOW_SNR_DB = 20;

/**
 * 麦克风打不开时说什么。三种原因的对策完全不同——
 * 权限被拒要去浏览器改设置，没设备要去插，被占用要去关别的程序。
 * 原来一律显示"权限被拒或设备不可用"，等于三种情况都没给出路。
 */
const MIC_HELP: Record<'denied' | 'missing' | 'busy' | 'other', { title: string; body: React.ReactNode }> = {
  denied: {
    title: '这个网站的麦克风权限被拒了',
    body: (
      <>
        Chrome 记住了这个选择，再点「录音」也不会弹窗。改回来：点<strong>地址栏最左边那个图标</strong>
        （小锁或滑块）→ 找到「麦克风」→ 改成「允许」→ <strong>刷新本页</strong>。
      </>
    ),
  },
  missing: {
    title: '系统里找不到麦克风',
    body: <>插一个，或者去系统声音设置里确认输入设备是启用的。插好之后刷新本页。</>,
  },
  busy: {
    title: '麦克风被别的程序占着',
    body: <>会议软件、录屏工具这类常会独占麦克风。把它们关掉或退出会议，再回来点「录音」。</>,
  },
  other: {
    title: '麦克风打不开',
    // 这是「都试过了还不行」的最后一档，最需要给得出下一步——而它原来给的是
    // 「看浏览器控制台里 getUserMedia 报的是什么」：控制台和 API 名字，
    // 对一个双击启动、不写代码的人是死路。先给他真能做的那几件。
    body: <>刷新一下再试；还不行就换一个浏览器（Chrome、Edge 都行），或者重启一下电脑再打开。</>,
  },
};

// 二选一对比的条数上限。每条一次解码，太多会让「评测」明显变慢；服务端返回的对比项
// 本来就是按音素位置顺序给的，取前几条就覆盖了最容易混的那些音。
const MAX_CONTRASTS = 3;

// 两条评测路径的结果。主路径是音素级（本地边车，说得出你实际发了什么音）；
// 边车没起时降级回 vosk 二选一，必须**标明**是降级——那条路只能在给定的两个词里挑
// 一个，说不出第三种可能，把它的结论当成音素级诊断会误导人。
type Listened =
  | { engine: 'phoneme'; result: PronounceResult }
  | { engine: 'vosk'; verdicts: ContrastVerdict[]; diff: AsrResult | null; why: string };

// 录音 + A/B 对比 + 本地评测。三件事互不依赖：录音/A对比全程只用浏览器原生能力，
// 跟 ASR 模型装没装无关，模型缺失时依然可用；只有「评测」这一个按钮受模型可用性控制。
// 用户的录音只留在浏览器内存/Blob URL 里，从不上传——上传给服务端的只有识别出的文本。
export default function Recorder({ target, entry, referenceUrl, onResult, hint = 'full' }: Props) {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const abAudios = useRef<HTMLAudioElement[]>([]);
  const abObjectUrl = useRef<string | null>(null);
  // 剪过静音的参考音，按源 URL 缓存：解码 mp3 要几十毫秒，每次 A/B 都重来会有可闻的延迟。
  const refWav = useRef<{ src: string; url: string } | null>(null);
  // A/B 的代次。abPlay 现在要 await 解码参考音，其间用户可能又点了一次或换了词——
  // 旧那次醒来后若继续播，两次会叠在一起响。
  const abSeq = useRef(0);
  // A/B 对比里"我的录音放完 → 隔 300ms 再放参考音"的那个定时器。必须存下来能取消：
  // 它的回调闭包直接抓着 reference 元素，stopAb() 清空 abAudios 之后也拦不住它开播。
  const abTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 评测的代次。首次加载大模型要几十秒，这期间用户完全可能再录一次；旧的那次评测
  // 结束后若直接 setListened，就会把上一段录音的判定盖到新录音上——显示的音素结论
  // 跟你刚念的那一遍对不上，而且看不出哪里不对。每次录音/评测都 +1，只认最新一代。
  const listenSeq = useRef(0);
  // 说完自动停的检测器。必须能取消并释放——它自己开了一个 AudioContext，
  // 不关会一直占着音频资源（组件卸载、手动停止、连点重录都要清）。
  const endpointer = useRef<Endpointer | null>(null);
  // start() 是否正在进行中。理由见 start() 顶上那段：await getUserMedia 期间按钮还是可点的。
  const starting = useRef(false);

  const [recording, setRecording] = useState(false);
  const [preparing, setPreparing] = useState(false);
  // 解码+剪静音后的样本。评测直接吃它，A/B 播它编出来的 WAV——两边是同一段音频。
  const [clip, setClip] = useState<Clip | null>(null);
  const [modelState, setModelState] = useState<ModelAvailability>('checking');
  const [busy, setBusy] = useState(false);
  const [listened, setListened] = useState<Listened | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);
  /**
     * 边车状态。**四档而不是三档：多出来的 'starting' 是必须的。**
     *
     * 服务一绑上端口浏览器就自动打开了，而边车还要十几秒加载 1.2GB 模型。
     * 只在挂载时问一次的话，那一次必然落在没就绪的窗口里，然后「没启动」这条提示
     * 永远挂着直到手动刷新——而且它跟事实相反（它正在启动）。
     * 所以没就绪就接着问，熬过 GIVE_UP_MS 才算真没起来。
     */
  const [sidecar, setSidecar] = useState<'checking' | 'starting' | 'up' | 'down' | 'no-uv'>('checking');
  /**
   * 麦克风打不开的原因。用**常驻提示**而不是一闪而过的 message：
   * 权限一旦被拒就不会自己好，再点录音永远失败——那条说明必须留在屏幕上，
   * 而且要说清去哪儿改。三种原因的对策完全不同，不能糊成一句"权限被拒或设备不可用"。
   */
  const [micError, setMicError] = useState<'denied' | 'missing' | 'busy' | 'other' | null>(null);
  /**
   * 词典 API key 配了没有。只用来决定"这次跟词典比"那条提示给什么建议：
   * 没配 key 是**一句话能解决**的（去设置页填上，以后每个词都有真人录音）；
   * 配了 key 还走词典，说明是这个词本身没有真人录音（或者是短语——短语的整段音频
   * 服务端只有合成音），那就没什么可做的，不该让人白跑一趟设置页。
   * null = 还没问到，那就不提建议，只说事实。
   */
  const [mwKey, setMwKey] = useState<boolean | null>(null);

  useEffect(() => {
    checkModelAvailability().then(setModelState);
    api.getMwKey()
      .then((r) => setMwKey(r.configured))
      .catch(() => setMwKey(null));   // 问不到就不给建议，别猜
  }, []);

  // 边车在不在，决定页面该提示什么：边车在的话 vosk 模型装没装根本不重要。
  // **一直问到它起来为止**（理由见 sidecar 那个 state 上的注释）。
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();

    const ask = () => {
      api.pronounceHealth()
        .then((r) => {
          if (!alive) return;
          if (r.ok) { setSidecar('up'); return; }        // 起来了就不再问
          // **没装 uv 就别等了。** 边车是 uv 拉起来的，没有 uv 它永远不会好。
          // 原来一律说「正在加载模型，稍等十几秒」，熬满 90 秒才改口叫人去看终端——
          // 而一个从没装过 Python 的新用户，那 90 秒是纯粹的空等，
          // 且他多半是双击启动的，本来就是为了不碰终端。
          // **只认明确的 false**。字段缺失（旧服务、响应被截断）时不下这个结论——
          // 说"你没装 uv"是一句关于他机器的断言，没证据就不许说，退回原来的等待逻辑。
          if (r.uv === false) { setSidecar('no-uv'); return; }
          again();
        })
        .catch(() => { if (alive) again(); });
    };

    const again = () => {
      // 模型冷启动实测十几秒，冷缓存下更久。熬过这个时间还不行，才是真没起来。
      setSidecar(Date.now() - started > GIVE_UP_MS ? 'down' : 'starting');
      if (Date.now() - started > GIVE_UP_MS) return;
      timer = setTimeout(ask, POLL_MS);
    };

    ask();
    // 卸载必须清掉在途的定时器，否则换了页面它还在轮询，而且会对已卸载的组件 setState
    return () => { alive = false; if (timer !== null) clearTimeout(timer); };
  }, []);

  function stopAb() {
    // 作废在途的 abPlay：它可能正卡在解码参考音那一步，醒来后会照常开播。
    abSeq.current++;
    // 先取消待触发的间隔定时器，再摘 onended、暂停元素。顺序不能反：定时器一旦触发就会
    // 让 reference 开始播放，而那时它已经不在 abAudios 里了，后面谁也停不下它。
    if (abTimer.current !== null) {
      clearTimeout(abTimer.current);
      abTimer.current = null;
    }
    abAudios.current.forEach((a) => {
      // onended 必须一起摘掉：'ended' 是排队投递的媒体事件，若它恰好在 stopAb() 之后才
      // 送达，处理器会再武装一个新定时器，而那时组件可能已经卸载，再没有谁能清掉它。
      a.onended = null;
      a.pause();
    });
    abAudios.current = [];
    if (abObjectUrl.current) {
      URL.revokeObjectURL(abObjectUrl.current);
      abObjectUrl.current = null;
    }
  }

  useEffect(() => () => {
    endpointer.current?.stop();
    endpointer.current = null;
    stopAb();
    if (refWav.current) URL.revokeObjectURL(refWav.current.url);
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // 参考音也要剪掉前后静音，否则 A/B 里"我的录音 → 参考音"之间会被它自带的空白撑开
  // 一大段，两个发音挨不到一起，对比就没意义了（录音那一侧早就剪过）。
  // 解码失败（格式不认、取不到）时退回原始 URL：宁可带点空白，也不能让 A/B 用不了。
  async function referenceSrc(src: string): Promise<string> {
    if (refWav.current?.src === src) return refWav.current.url;
    try {
      const res = await fetch(src);
      if (!res.ok) return src;
      const url = URL.createObjectURL(clipToWavBlob(await blobToClip(await res.blob())));
      if (refWav.current) URL.revokeObjectURL(refWav.current.url);
      refWav.current = { src, url };
      return url;
    } catch {
      return src;
    }
  }

  async function start() {
    if (!micSupported) {
      // 端口不能写死。**同一句话下面那条 Notice 里也有一份**（用的是 location.port），
      // 而这里原来写死 30031——`.env` 里 PORT 改过之后，两处一个对一个错。
      message.error(insecureOrigin
        ? `这个地址不能用麦克风。换成 ${localAppUrl()} 打开就行`
        // API 名字对这个应用的用户没有意义，能做的那件事才有：换个浏览器
        : '当前浏览器不支持录音，换 Chrome 或 Edge 试试');
      return;
    }
    // ── 重入守卫。按钮的 disabled 挡不住这个窗口 ──
    //
    // start() 是 async，而 setRecording(true) 排在 await getUserMedia 之后。也就是说
    // 从点下去到流拿到手这段时间里，按钮既不 recording 也不 working，**仍然是可点的**。
    // 连点两下就是两次 getUserMedia、两个 MediaRecorder，而 streamRef/rec 只存得下一个
    // ——第一条流没人再停得掉它，麦克风那个红点会一直亮着。
    //
    // 用 ref 而不是 state：state 要等重渲染才生效，而这里要防的恰恰是同一批事件里的第二下。
    // 处理期（preparing/busy）也一并挡住：那时开新录音会 listenSeq.current++ 把在途的
    // 评测作废，用户等的结果凭空消失。UI 上按钮已经禁用，但键盘和程序化调用绕得过 disabled。
    if (starting.current || preparing || busy) return;
    starting.current = true;
    stopAb();
    try {
      // 显式接管 Chrome 的三项默认处理，别让它替我们做主：
      // - echoCancellation：这里没有远端声音要消，纯属白跑一趟处理
      // - autoGainControl：它会动态改电平，把振幅包络也一起改了；A/B 对比要的是原样
      // - noiseSuppression：**两面刃**。它压制的是"类噪声信号"，而擦音（/s/ /θ/ /ʃ/ /f/）
      //   本身就是噪声，很容易被一起削掉——正是这个工具最要分辨的那批音。
      //   所以做成开关放在设置里，让真实录音去决定，而不是在这儿替用户猜。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: localStorage.getItem(NS_KEY) !== 'off',
        },
      });
      setMicError(null);
      streamRef.current = stream;
      chunks.current = [];
      const recorder = new MediaRecorder(stream);
      rec.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      recorder.onstop = () => {
        // 只处理自己这一次录音：连点「停止→录音」时，旧 recorder 的迟到事件不该动新一次的状态
        if (rec.current !== recorder) return;
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunks.current, { type: chunks.current[0]?.type ?? 'audio/webm' });
        setPreparing(true);
        // 停止时就解码+剪静音，而不是等点「评测」才做：A/B 也要用剪过的这一份，
        // 而且提前备好，点下去就能立刻响。
        blobToClip(blob)
          .then((c) => {
            if (rec.current !== recorder) return;
            setClip(c);
            // 录完直接评测，不用再点一次——录音的目的本来就是为了看判定结果。
            // 模型没装/没检测好时静默跳过：那种情况下 UI 上已经有一条明确的提示了。
            void listen(c);
          })
          .catch(() => message.error('这段录音处理不了，再录一次试试'))
          .finally(() => setPreparing(false));
      };
      recorder.start();

      // 说完自动停。那个「停止」按钮的名字怎么起都不对：「停止」含糊（停什么？）、
      // 「念完了」像聊天回复不像控件、「结束并评测」太长而且一天要按几十次。
      // 最好的答案是这一下根本不用按。
      endpointer.current?.stop();
      endpointer.current = detectEndOfSpeech(stream, (reason) => {
        endpointer.current = null;
        if (rec.current !== recorder) return;       // 已经被别的路径停掉了
        if (reason === 'no-speech') message.warning('没听到人声，再试一次');
        if (reason === 'too-long') message.warning('录太长了，先按这一段处理');
        stop();
      });

      // 作废在途的上一次评测：它的结果属于上一段录音，不该出现在这一段的结果区。
      listenSeq.current++;
      setRecording(true);
      setClip(null);
      setListened(null);
      setAsrError(null);
      setBusy(false);
    } catch (e) {
      // getUserMedia 的失败原因决定了该做什么，糊成一句话等于什么都没说。
      // 名字取自 W3C 规范，旧版 Chrome 还会用带 Devices/Track 前缀的老名字。
      const name = (e as { name?: string }).name ?? '';
      setMicError(
        name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError' ? 'denied'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError' ? 'missing'
            : name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError' ? 'busy'
              : 'other',
      );
    } finally {
      starting.current = false;
    }
  }

  function stop() {
    endpointer.current?.stop();
    endpointer.current = null;
    rec.current?.stop();
    setRecording(false);
  }

  async function abPlay() {
    if (!clip || !referenceUrl) return;
    stopAb();
    const seq = ++abSeq.current;
    const refSrc = await referenceSrc(referenceUrl);
    // 解码期间又点了一次 A/B（或组件已卸载）：这一次作废，否则两次会叠着响。
    // 注意要在建 Audio 之前就退出——建完再退出就得自己收拾，没必要。
    if (abSeq.current !== seq) return;

    const url = URL.createObjectURL(clipToWavBlob(clip));
    abObjectUrl.current = url;
    const mine = new Audio(url);
    const reference = new Audio(refSrc);
    abAudios.current = [mine, reference];
    mine.onended = () => {
      abTimer.current = setTimeout(() => {
        abTimer.current = null;
        reference.play().catch(onPlayFailure('参考音频播放失败'));
      }, 300);
    };
    reference.onended = () => {
      // 可能已被下一次 abPlay()/卸载时的 stopAb() 抢先 revoke，比对引用避免误 revoke 新的
      if (abObjectUrl.current === url) {
        URL.revokeObjectURL(url);
        abObjectUrl.current = null;
      }
    };
    mine.play().catch(onPlayFailure('录音播放失败'));
  }

  // 显式收 clip 参数而不是读 state：录完自动评测时 setClip 刚调用、state 还没更新到，
  // 直接读 clip 会拿到上一次（或 null）。
  async function listen(c: Clip) {
    const seq = ++listenSeq.current;
    const fresh = () => listenSeq.current === seq;
    setBusy(true);
    setAsrError(null);
    try {
      // 主路径：本地音素识别边车。它不受词表约束，能说出你实际发的是什么音。
      const res = await api.pronounce(target, clipToWavBlob(c), entry, c.snrDb);
      if (!fresh()) return;
      if (res.ok) {
        setListened({ engine: 'phoneme', result: res.data });
        onResult?.(res.data);
        return;
      }
      if (!res.sidecarDown) {
        // 400 之类：这个词 CMUdict 里没有等等，降级也解决不了，直接说清楚
        setAsrError(res.error);
        onResult?.(null);
        return;
      }
      // 边车没起 → 往下走 vosk 降级路径
      if (modelState !== 'available') {
        setAsrError(`${res.error}（备用模型也没装，这次测不了）`);
        onResult?.(null);
        return;
      }
      // 降级到 vosk：那条路只能在给定的两个词里挑一个，测不出"你实际发了什么音"，
      // 不能拿它的结论去打分。
      onResult?.(null);
      await listenWithVosk(c, fresh, res.error);
    } catch (e) {
      if (!fresh()) return;
      setAsrError(e instanceof Error ? e.message : '评测失败');
      message.error('评测失败');
      onResult?.(null);
    } finally {
      if (fresh()) setBusy(false);
    }
  }

  // 降级路径：vosk 二选一。只在边车连不上时才走。
  async function listenWithVosk(c: Clip, fresh: () => boolean, why: string) {
    {
      // 对比项由服务端从笔记的 phoneme trigger 派生（见 analysis/confusions.ts），
      // 客户端不自己猜拼写。一条都拿不到就没得比——直说，别假装做了评测。
      let contrasts: Contrast[] = [];
      try {
        contrasts = (await api.confusions(target)).contrasts.slice(0, MAX_CONTRASTS);
      } catch {
        contrasts = [];
      }
      const verdicts = await contrastAll(c.samples, target, contrasts);
      if (!fresh()) return;

      // 输掉的那条：你把 targetIpa 发成了 partnerIpa。拿去 /api/asr 换回对应的笔记链接。
      const lost = verdicts.find((v) => v.winner === 'partner');
      const diff = lost ? await api.asr(target, lost.word) : null;
      if (!fresh()) return;
      setListened({ engine: 'vosk', verdicts, diff, why });
    }
  }

  const clipSeconds = clip ? (clip.samples.length / clip.sampleRate).toFixed(1) : null;

  /**
   * 录音停下之后到结果出来之间的这一段：先解码剪静音（preparing），紧接着评测（busy）。
   * 合成一个标志，是因为按钮该不该是活的取决于"整段处理是否在进行"，而不是它内部走到哪一步——
   * 分开判会在两步之间留一帧空档，而那一帧恰好就是误点最容易落进去的地方。
   */
  const working = preparing || busy;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {/* ── 常驻的活动区 ──
             这一整套的三次变化——开始听、在评测、结果出来——都不是用户点出来的，
             屏幕上看得见，读屏那边全程无声（实测词条页一个活动区都没有）。
             **必须常驻**：节点和内容同时出现的话，读屏未必会念；这里节点一直在，
             只有文字变。视觉上不占位（.sr-only），说的话跟屏幕上那几句同源。 */}
      <span className="sr-only" role="status">
        {recording ? '在听着，念出来'
          : busy ? '在评测'
            : listened?.engine === 'phoneme' ? headline(listened.result)
              : ''}
      </span>
      <Space wrap>
        {/* ── 自动停之后那一小段，这个按钮**不能是活的** ──
               标签会在光标底下连变两次（停止录音 → 录音 → 重新录），而 onClick 已经从
               stop 变成了 start。瞄着「停止录音」点下去，实际是开了一段新录音，
               **顺手把在途的评测作废**（start() 里 listenSeq.current++），等的结果凭空消失。
               所以整段处理期固定成「处理中」并禁用：误点什么也不会发生，标签也不再跳。 */}
          {/* 这一页最重要的动作，得看起来就是——旁边两个多数时候还是禁用的。
              录音中保留 danger：红作为"正在录"的实时状态是通用约定，标的是状态不是动作。 */}
        <Button
          type="primary"
          icon={<AudioOutlined />}
          danger={recording}
          onClick={recording ? stop : start}
          disabled={!micSupported || working}
          loading={working}
        >
          {/* 「录音」是惯用词，谁都懂，这里机制就是动作（跟「保存」一样）——不必替它改名。
              真正含糊的只有「停止」：停什么？而且现在停下来会顺带触发评测。
              所以补全宾语叫「停止录音」，同时上了说完自动停——这一下基本不用按。
              试过「开始念 / 念完了」，更糟：后者是第一人称陈述，读起来像聊天回复不像控件。 */}
          {recording ? '停止录音' : working ? '处理中' : clip ? '重新录' : '录音'}
        </Button>
        {/* 「对比播放」照旧摆着（没录音时它灰得一目了然：拿什么去对比）。
            referenceUrl 为 null 那种灰不一目了然，下面有常驻说明专门讲它。 */}
        <Button icon={<SwapOutlined />} disabled={!clip || !referenceUrl || working} onClick={() => void abPlay()}>
          对比播放
        </Button>
        {/* ── 「评测」在没录音之前根本不出现 ──
               它跟旁边那个不一样：**紧挨着的那句话写的是「念完它自己停，然后自动评测」**。
               一句说自动、一个按钮摆在那儿还是灰的，第一次用的人只会想"到底要不要点它"。
               而这个按钮真正的用处是**再来一次**——录完之后自动评测已经跑过，
               它那时叫「重新评测」；只有自动那次失败了才叫「评测」，那时它确实
               是要人按的那一下。两种有用的状态都在有 clip 之后，所以之前不必占位。

               「对比播放」没有这个毛病：没有哪句话说它会自动发生。
               上一版把「录音」提成主按钮、另两个降级——那治的是"三个一样重、
               不知道先点哪个"，没治这处自相矛盾。 */}
        {clip && (
          <Button disabled={working} onClick={() => void listen(clip)}>
            {listened ? '重新评测' : '评测'}
          </Button>
        )}
        {/* 录音中必须有反馈：既让人知道它在听，也说清不用自己按停 */}
        {recording && (
          <Typography.Text style={{ fontSize: 12.5, color: 'var(--blue)' }}>
            在听着 —— 念出来，停下就自动结束
          </Typography.Text>
        )}
        {/* 处理期也必须有话说，否则三个按钮同时变灰、没有任何交代。
            这一句同时解释了「为什么现在点不了」——仓库对禁用控件的一贯要求。 */}
        {working && (
          <Typography.Text style={{ fontSize: 12.5, color: 'var(--blue)' }}>
            {busy ? '在评测 —— 结果马上出来，这会儿先别动' : '在处理这段录音…'}
          </Typography.Text>
        )}
        {!recording && !working && clip && (
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 11.5 }}>
            剪完 {clipSeconds}s · 信噪比 {Math.round(clip.snrDb)}dB
            {clip.snrDb < LOW_SNR_DB && ' · 背景有点吵'}
          </Typography.Text>
        )}
      </Space>

      {/* ── 「对比播放」为什么是灰的 ──
             `!clip` 那种灰不用解释（还没录音，一目了然）。`referenceUrl` 为 null 才需要：
             那是"这个词一个参考音都没抓到"，而灰按钮看上去跟"功能坏了"没有区别。
             这个仓库对失败的一贯做法就是常驻说明 + 说清去哪儿改（见上面 micError 那段注释），
             独独这一个控件是默默变灰的。

             什么时候会走到这儿：真人录音没抓到（没配 key，或词典里就没有这个词的录音），
             而且 edge-tts 也失败了（实测这台机器连不上微软的合成服务，ETIMEDOUT）。
             这时 AudioPlayer 会退到浏览器自己朗读——听是能听，但那个声音取不出来做对比。 */}
      {!referenceUrl && (
        <Notice tone="quiet" label="没有参考音" title="这个词没抓到参考发音，对比播放用不了">
          录音和评测照常用。上面的喇叭还是能听，但那是浏览器自己朗读的，取不出来跟你的录音对播。
          {mwKey === false && <> 去<Link to="/settings">设置页</Link>配一个词典 API key，就能抓到真人录音。</>}
          {mwKey === true && ' 合成服务这次也没连上——启动服务那个终端里有一行 [tts] 开头的原因。'}
        </Notice>
      )}

      {clip && clip.snrDb < LOW_SNR_DB && (
        <Notice tone="warn" label={`信噪比 ${Math.round(clip.snrDb)}dB`} title="背景噪音偏大，识别结果会不稳">
          安静一点的环境、或者离麦克风近一些，通常能到 30dB 以上。
          {'如果换了环境还是这样，去'}<Link to="/settings">设置</Link>里试试关掉浏览器降噪——
          {'它可能把 /s/ /θ/ /ʃ/ 这些擦音一起削掉了。'}
        </Notice>
      )}

      {micError && (
        <Notice tone="warn" label="麦克风打不开" title={MIC_HELP[micError].title}>
          {MIC_HELP[micError].body}
        </Notice>
      )}

      {!micSupported && (
        insecureOrigin ? (
          <Notice tone="warn" label="这个地址录不了音" title="浏览器只在安全地址上给麦克风">
            你现在是通过 <Typography.Text code>{location.host}</Typography.Text> 打开的。
            {'浏览器只把 '}<Typography.Text code>localhost</Typography.Text> 和 https 当成安全地址，
            {'其它 http 地址一律不给麦克风——'}<strong>这不是浏览器不支持，是地址的限制</strong>。
            <br />
            在<strong>这台机器上</strong>用 <Typography.Text code copyable>{localAppUrl()}</Typography.Text>{' '}
            打开就能录。查词、音素、笔记在当前这个地址下都正常，只有录音和评测用不了。
          </Notice>
        ) : (
          <Alert type="warning" showIcon message="当前浏览器不支持录音，只能听参考音频" />
        )
      )}

      {/* 边车状态的四条提示（正在启动 / 没装 uv / 等了一分半 / 备用模型检测失败）
             搬去了 AsrStatus——那是这台机器的状态，不是每个音节的状态。
             词条页逐音节各摆一个 Recorder，原来同一份三行字会整份重复多遍。
             sidecar 这个 state 留着，只因为它还管着下面那行操作说明的出现时机。 */}
      {/* 复习流里一次要过七八张卡，每张都摊开同样几行灰字就只是噪音——
             那时人在做题，不是在学怎么用。所以复习页（brief）只留操作那一句。 */}
      {sidecar === 'up' && !listened && !busy && (
        <Typography.Text type="secondary" className="measure">
          {hint === 'brief' ? (
            <>点「录音」念出来——<strong>念完它自己停</strong>，然后自动评测。</>
          ) : (
            <>
              点「录音」念出来——<strong>念完它自己停</strong>，然后自动评测。
              {'它不受词表约束，'}<strong>你发成什么音它就写什么音</strong>
              {'，所以说得出你错在第几个音。录音只在本机走，不落盘、不出这台机器。'}
            </>
          )}
        </Typography.Text>
      )}

      {asrError && (
        <Alert type="error" showIcon closable message="评测出错" description={asrError} onClose={() => setAsrError(null)} />
      )}

      {listened?.engine === 'phoneme' && <PhonemeResult result={listened.result} mwKey={mwKey} />}
      {listened?.engine === 'vosk' && <Verdicts target={target} verdicts={listened.verdicts} diff={listened.diff} why={listened.why} />}
    </Space>
  );
}

// 音素级判定结果。每一行是一个音素位置上的二选一：把你的录音跟"只差这一个音"的词
// 放进同一个语法逼识别器选，赢了说明这个音你拉开了，输了说明你把它发成了对面那个音。
//
// 「输了」才是这次改造真正想要的信号。旧版逐词单独判别时两边都通过，永远给不出这个结论。
// 音素级结果。这是主路径的展示：逐个音素列出目标音 vs 实际听到的音，
// 并且能区分「发成了别的音」「漏了这个音」「多发了一个音」三种错法。
// 有没有把握由服务端在 op.sure 上给出（espeak.ts 的 CONFIDENT 是唯一门槛）。
// 模型拿不准的"错"不标红、不计入统计（服务端已经滤掉了），但仍然显示出来——
// 藏起来的话，模型真听岔了你却完全不知道，反而更难查。

/**
 * 音素级评测结果。**导出只是为了能测它**——它是纯展示组件（给一个 result 就渲染完），
 * 而外面的 Recorder 要驱动到这一步得先过 getUserMedia + MediaRecorder + AudioContext，
 * 在 jsdom 里全得打桩，成本远高于收益。
 *
 * 测的是 Recorder.test.tsx 里那件事：result 上每个影响可信度的字段，都必须改变渲染结果。
 */
export function PhonemeResult({ result, mwKey }: { result: PronounceResult; mwKey: boolean | null }) {
  const { align, notes, heardIpa } = result;
  const wrong = align.filter(isWrong);
  // 拿不准的【多余音】不算在这里：套印带已经把它们当杂音收走了（不占格子），
  // 这条提示若把它们数进来，会出现"说有灰格子、界面上却没有"的对不上。
  // **用 isNoise 而不是手写 kind !== 'ins'**：那条排除规则的家在 lib/align.ts，
  // 结构性复制一份的话，它一变这两处就失步，正好复现上面那句要避免的对不上。
  const unsure = align.filter((op) => op.kind !== 'match' && !op.sure && !isNoise(op));

  // 服务端现在会在更早的地方就把空识别拦成 422（否则目标音会被逐个记成"没发出来"，
  // 进统计、进「该补的笔记」、还生成复习卡），所以正常走不到这里。留着是因为这条分支
  // 挡的是最坏的一种错法——落进"wrong.length === 0 → 每个音都发对了"，
  // 等于对着一段静音说你念对了。
  if (heardIpa.length === 0) {
    return (
      <Notice tone="warn" label="没听出来" title="一个音都没识别出来">
        可能音量太小，或者录进去的全是环境噪音。再录一次。
      </Notice>
    );
  }

  // 第一处发错的替换 —— 部位尺画的就是它。一次只讲一件事：同时铺三张图，
  // 人不知道该先练哪个。
  const firstSub = wrong.find((op) => op.kind === 'sub') as
    { kind: 'sub'; targetIpa: string; heardIpa: string } | undefined;

  // ── 「你发出来的」要念**判定之后**的那一串，不是模型的原始转写 ──
  //
  // 直接显示原始转写会跟同一屏的标题打架：cup 判定「每个音都发对了」，
  // 而这一行写着「你发出来的 [kæp]」——cup 是 /kʌp/，那句话在说你念成了 cap。
  // **标题和音标同屏矛盾，人信音标。**
  //
  // 服务端早有这条规矩（match 的两版必须同字），但它只作用在 align 上，
  // 而这一行另外读了一个顶层字段——同一件事的第二套规则。
  // del 不进这一串：它说的就是"这个音你没发出来"。原始转写在 API 里照旧完整。
  const spoken = align.filter((op) => op.kind !== 'del').map((op) => op.heardIpa);

  return (
    <Space direction="vertical" size={26} style={{ width: '100%' }}>
      {/* 签名元素：套印带 */}
      <OverprintStrip align={align} />

      <Space direction="vertical" size={4}>
        {/* ── 三态，不是两态 ──
               原来是「有确凿的错 ? 报错 : 每个音都发对了」，于是
               thin [θ ɪ n] → [f ɛ n] 被判成「每个音都发对了」——θ→f 和 ɪ→ɛ
               两处置信度都没过门槛，整条就"没有错"了。实测 47 次里 6 次判全对，
               **5 次是这么来的**。下面那行小字确实提了"有几处模型没定"，
               但**标题在说谎，而更正藏在灰字里**，人读的是标题。
               「没有确凿的错」不等于「对」，它等于这次没测准。 */}
        <Typography.Text style={{ fontSize: 16 }}>{headline(result)}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }} className="mono">
          你发出来的 {phonetic(spoken)}
          {unsure.length > 0 && `　· 标成「${UNSURE}」的那几处模型自己也没定，没计入进度`}
        </Typography.Text>
      </Space>

      {/* ── 这次算不算数 ──
             背景太吵时服务端照样给结果（你需要反馈），但不写进发音档案和复习队列。
             **必须说出来**：静悄悄地不计入比计入更糟——你会以为练过的都算数，
             而档案里根本没有这一次。判断在服务端，这里只负责显示它的结论。 */}
      {!result.recorded && result.notRecordedReason && (
        <Notice tone="warn" label="这次没计入" title={result.notRecordedReason}>
          结果照样给你看，但不会记进发音档案，也不会生成复习卡——
          {'录音条件坏掉时模型的输出很不稳，那批数据记下来会变成"你的习惯性短板"，'}
          {'而它记的其实是当时房间里的噪声。环境安静下来再录一次，这次就算数了。'}
        </Notice>
      )}

      {/* ── 这次是拿什么当基准比的 ──
             只在走词典时出现。跟真人录音比是正常情况，多一句只会稀释注意力。
             对**没配词典 API key 的人这是全局的**：每一次评测都走词典基准，
             却看到跟真人基准一样自信的逐音素判定。 */}
        {/* ── 参考音被你的录音纠正过：**不在这里说** ──
             纠正修的正是"你觉得自己念对了、工具却说错"那种情况，而修完之后那种情况
             就不会发生——所以那行字没有听众。它是校准细节不是结果，
             API 里的 baselineRepaired 保留（curl 得到），只是不摆进每次的评测流。 */}

      {result.comparedWith === 'dictionary' && (
        <Notice tone="quiet" label="这次的基准" title="跟词典音标比的，不是跟真人录音">
          <strong>辅音的判断照常可信，元音要打个折扣</strong>——模型转写元音时有系统性偏移
          {'（实测元音置信度中位数 0.70，辅音 0.94），只有让真人录音过同一个模型、两边抵消才消得掉。'}
          {mwKey === false && <> 去<Link to="/settings">设置页</Link>配一个词典 API key，以后每个词都能自动抓到真人录音。</>}
          {mwKey === true && ' 这个词词典里没有真人录音（短语也一样，整段只有合成音），只能走这条路。'}
        </Notice>
      )}

      {/* 身体上哪一步做错了。只有替换错才画——漏音和多音谈不上"位置差在哪" */}
      {firstSub && <PlaceRuler targetIpa={firstSub.targetIpa} heardIpa={firstSub.heardIpa} />}

      {wrong.length === 0 ? (
        <Typography.Text className="measure" type="secondary">
          这是音素层面的比对。音色、时长、重音它测不了——那部分靠 A/B 对比自己听。
        </Typography.Text>
      ) : notes.length > 0 ? (
        // 报了错就得给出"该怎么动舌头"的入口——只丢个链接等于只骂不教。
        <Collapse
          size="small"
          bordered={false}
          /* **一篇都不自动摊开**，全部收着，点哪篇由人自己定。
             这一条走过两版：先是"每一篇都摊开"（一次好录音反而铺出最长的一屏，
             短语逐词录更长），改成"只摊开第一篇"，使用者还是说不要——
             「怎么改 这个就不要自动打开，让用户自己判断打开哪个」。
             他是对的：自动摊开哪一篇，等于替他决定先练什么，而那个判断
             （哪处错最要紧、今天想练哪个）只有他自己做得了。
             标题全在、次序仍按相关性排（讲这个词的排最前），选择权交回去。 */
          defaultActiveKey={[]}
          items={notes.map((n) => ({
            key: n.id,
            label: <span style={{ fontWeight: 600 }}>怎么改 · {n.title}</span>,
            children: (
              <Space direction="vertical" size={14} style={{ width: '100%' }}>
                {n.guidance.length > 0 ? n.guidance.map((g) => (
                  <div key={g.heading}>
                    <span className="slug" style={{ letterSpacing: '.12em' }}>{g.heading}</span>
                    <div className="note-md" style={{ marginTop: 6 }}><Markdown>{g.body}</Markdown></div>
                  </div>
                )) : (
                  <Typography.Text type="secondary">
                    这篇笔记里没写具体的发音动作。让 AI 补一段"该怎么发"。
                  </Typography.Text>
                )}
                <Link to={`/notes/${n.id}`}>看完整笔记 →</Link>
              </Space>
            ),
          }))}
        />
      ) : (
        // 没有笔记 = 这个音还没人教过你。这正是该去问 AI 的信号，说破它。
        <Notice tone="warn" label="缺一篇笔记" title="这几个音还没有笔记">
          把这次的结果告诉 AI，让它写一篇——写完之后这里会自动出现"该怎么改"。
          <Link to="/stats"> 发音统计</Link>里也列着反复出错却还没有笔记的音。
        </Notice>
      )}
    </Space>
  );
}

/**
 * 结果那一句话。**两处用它**：屏幕上那行标题，和播报给读屏的活动区——
 * 同一句话不该有两个版本。
 */
export function headline(result: PronounceResult): string {
  if (result.heardIpa.length === 0) return '一个音都没识别出来，再录一次';
  const wrong = result.align.filter(isWrong);
  const unsure = result.align.filter((op) => op.kind !== 'match' && !op.sure && !isNoise(op));
  if (wrong.length > 0) return summarize(wrong);
  if (unsure.length > 0) return `这次没测准——有 ${unsure.length} 处模型听到了别的音、但自己没把握。再念一遍。`;
  return '每个音都发对了。';
}

/** 把几处错说成一句人话。不甩 sub/del/ins */
function summarize(wrong: PronounceResult['align']): string {
  const parts: string[] = [];
  const subs = wrong.filter((o) => o.kind === 'sub').length;
  const dels = wrong.filter((o) => o.kind === 'del').length;
  const ins = wrong.filter((o) => o.kind === 'ins').length;
  if (subs) parts.push(`${subs} 个音发成了别的音`);
  if (dels) parts.push(`${dels} 个音没发出来`);
  if (ins) parts.push(`多发了 ${ins} 个音`);
  return parts.join('、');
}
