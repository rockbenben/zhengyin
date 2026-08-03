// 浏览器本地语音识别。vosk-browser 的生命周期全在这个模块里管，页面组件只调
// checkModelAvailability() / contrastAll()，不用碰 Model / KaldiRecognizer。
//
// 判别方式是**逐个音素做二选一强制对比**：每次只把 target 和"只差第 i 个音素"的那个
// 搭档词放进同一个语法，逼识别器在两者间选一个。
//
// 之前的做法是逐候选分别解码（语法 = [该词, "[unk]"]），那问的是"这是 night 还是垃圾"。
// [unk] 是故意做弱的垃圾模型，只要你发出的是像语音的东西，任何真词都赢它——于是
// night 通过、light 也通过，用起来就是"什么都说对"。换多大的模型都救不了，因为两个
// 候选词从头到尾没被放在一起比过。这是设计缺陷，不是阈值问题。
//
// 二选一的另一个好处：它**天然是音素级的**。target 和搭档词只差第 i 个音素，谁赢就等于
// 回答了"你第 i 个音发的是 targetIpa 还是 partnerIpa"。位置由服务端 /api/confusions
// 给出（server/src/analysis/confusions.ts 的 Contrast）。
//
// 做不到的事，写在这里免得以后又去找：vosk-browser 的 Worker 协议只接受 grammar、
// words 布尔和音频块（见 node_modules/vosk-browser/dist/interfaces.d.ts），**没有音素
// 对齐、没有 GOP 打分**。所以"逐音素给分"这条路在这个技术栈上不存在，音素级信息只能
// 靠上面这种对比构造出来。
//
// 关键设计目的：区分"模型没装"和"这次没听清"——checkModelAvailability() 只探测模型文件
// 在不在（HEAD，不下载），判别函数返回逐词结论，抛异常才代表模型本身有问题（没装/下载
// 失败/加载超时/识别器出错）。
//
// 客户端不猜"容易混淆的候选词"：音素级混淆推导（笔记 phoneme:<ipa> trigger 共现 +
// CMUdict 反查）只在服务端做，走 GET /api/confusions/:word。这跟 Task 15 定下的原则一致。

import type * as Vosk from 'vosk-browser';
import { api } from '../api';
import type { Contrast } from '../types';

// 模型文件名不写死在这儿：用户可以在设置页换大小模型，写死的话一换就指向不存在的文件。
// 由服务端 /api/settings/model 说了算（它和 scripts/fetch-model.mjs 读同一份清单）。
let urlPromise: Promise<string> | null = null;
function modelUrl(): Promise<string> {
  if (!urlPromise) {
    urlPromise = api.getModel().then((m) => `/api/model/${m.file}`);
    // 这一步失败（服务端没起来等）不该被永久缓存成"坏结果"——清掉，下次重来。
    urlPromise.catch(() => { urlPromise = null; });
  }
  return urlPromise;
}

/**
 * 换模型后调用：把缓存的 URL、可用性探测、已加载的模型全部丢弃，下次判别重新走一遍。
 * 不 terminate 旧模型——此刻可能正有一次评测在用它；vosk-browser 的 Model
 * 在最后一个引用被回收后自己收摊，而这里若强行 terminate 会让进行中的那次识别抛错。
 */
export function resetModel(): void {
  urlPromise = null;
  availabilityPromise = null;
  modelPromise = null;
}

export type ModelAvailability = 'checking' | 'available' | 'missing' | 'error';

// vosk-browser 把 RecognizerMessage/ModelMessage 的类型定义放在包内部的
// interfaces.d.ts，没有从主入口（dist/vosk.d.ts 只 re-export 了 model.d.ts）导出，
// on() 的类型签名也不按事件名字符串做判别联合收窄。这里只声明实际用到的最小字段
// （跑出来的真实消息形状，对照 node_modules/vosk-browser/dist/interfaces.d.ts 核对
// 过），不深挖 node_modules 内部路径导入。
interface VoskLoadMessage { result: boolean }
interface VoskResultMessage { result: { text: string; result?: Array<{ word: string; conf: number }> } }
interface VoskErrorMessage { error: string }

let availabilityPromise: Promise<ModelAvailability> | null = null;
// 只探测模型文件在不在（HEAD，不下载正文），跟真正加载模型（下面的 loadModel，要
// 拉完整模型并在 Worker 里解压/建图）分开——页面一打开就想知道"评测能不能用"，
// 但不能为了知道这件事就先背着用户下几十上百 MB，更不能因此拖慢首屏渲染。
export function checkModelAvailability(): Promise<ModelAvailability> {
  if (!availabilityPromise) {
    availabilityPromise = modelUrl()
      .then((url) => fetch(url, { method: 'HEAD' }))
      .then((r): ModelAvailability => (r.ok ? 'available' : 'missing'))
      .catch((): ModelAvailability => 'error');
  }
  return availabilityPromise;
}

let modelPromise: Promise<Vosk.Model> | null = null;

// 不用包自带的 createModel()：读 node_modules/vosk-browser/dist/vosk.js 发现它
// 返回的 Promise 只监听 "load" 事件——模型损坏/解压失败时 Worker 发的是 "error"
// 事件，createModel 的 Promise 既不 resolve 也不 reject，永远挂起。这里直接用
// Model 类自己监听 load + error 两种结果，并且额外兜底一个超时（网络中断等
// "两种事件都没收到"的情况），三条路径都清干净：resolve 一次、reject 一次、且
// 失败/超时时调 model.terminate() 别把 Worker 晾在那儿。
function loadModel(): Promise<Vosk.Model> {
  if (!modelPromise) {
    modelPromise = new Promise<Vosk.Model>((resolve, reject) => {
      let settled = false;
      let model: Vosk.Model | undefined;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          model?.terminate();
          reject(new Error('模型下载/加载超时'));
        });
      }, 120_000);

      // 动态 import：vosk-browser 打包后单文件 ~5.8MB（spike 实测 gzip 后 2.4MB），
      // 不能进主 bundle——只有用户真的点了「评测」才该拉这段代码，不能拖慢首屏。
      // 模型文件名要先问服务端（用户可能刚换过大小模型），跟动态 import 并发跑；
      // 上面那个 120s 超时把这一步也罩住了。
      Promise.all([import('vosk-browser'), modelUrl()])
        .then(([{ Model }, url]) => {
          model = new Model(url);
          model.on('load', (msg) => {
            settle(() => {
              if ((msg as unknown as VoskLoadMessage).result) resolve(model!);
              else { model!.terminate(); reject(new Error('模型加载失败')); }
            });
          });
          model.on('error', (msg) => {
            settle(() => {
              model!.terminate();
              reject(new Error((msg as unknown as VoskErrorMessage).error || '模型加载出错'));
            });
          });
        })
        .catch((e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
    }).catch((e: unknown) => {
      // 失败别把坏 promise 缓存住，下次评测还能重试（比如第一次网络抖了一下）。
      modelPromise = null;
      throw e;
    });
  }
  return modelPromise;
}

// Vosk 语法约束模式下，识别不出任何候选词时可能落到语法表里显式声明的 [unk]，
// 也可能就是空字符串——两者都该当"没听清"处理，不能把字面量 "[unk]" 当成一个
// 真的识别结果发给用户看（"机器听成了「[unk]」"是没意义的）。
function normalizeHeard(text: string): string | null {
  const trimmed = text.trim();
  return trimmed && trimmed !== '[unk]' ? trimmed : null;
}

/** 一次二选一对比的结果 */
export interface ContrastVerdict extends Contrast {
  /** 识别器在 target 和 word 之间选了谁；两个都没选中（落到 [unk]）时为 null */
  winner: 'target' | 'partner' | null;
  /** 胜者的置信度（setWords(true) 才有），拿不到则为 null */
  conf: number | null;
}

// 把 target 和搭档词放进同一个语法，逼识别器二选一。[unk] 仍然留着——整段没录到语音时
// 该落到它上面，那是"没听清"，跟"选错了"是两回事，不能混成同一个结论。
function decodeContrast(
  model: Vosk.Model, samples: Float32Array, target: string, c: Contrast,
): Promise<ContrastVerdict> {
  return new Promise<ContrastVerdict>((resolve, reject) => {
    const rec = new model.KaldiRecognizer(16000, JSON.stringify([target, c.word, '[unk]']));
    rec.setWords(true);          // 要逐词置信度，默认只给纯文本
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => { rec.remove(); reject(new Error('评测超时')); });
    }, 20_000);

    rec.on('error', (msg) => {
      settle(() => {
        rec.remove();
        reject(new Error((msg as unknown as VoskErrorMessage).error || '这段录音没能识别，再录一次试试'));
      });
    });
    rec.on('result', (msg) => {
      settle(() => {
        const r = (msg as unknown as VoskResultMessage).result;
        rec.remove();
        const heard = normalizeHeard(r.text);
        const winner = heard === target ? 'target' : heard === c.word ? 'partner' : null;
        // conf 取胜者那个词的。heard 为 null（落到 [unk]）时没有胜者，conf 也就没有意义。
        const hit = winner === null ? undefined : r.result?.find((x) => x.word === heard);
        resolve({ ...c, winner, conf: hit ? hit.conf : null });
      });
    });
    rec.acceptWaveformFloat(samples, 16000);
    rec.retrieveFinalResult();
  });
}

/**
 * 逐条跑二选一对比。串行而不是并发：每条对比都要在同一个 Worker 里建识别器、灌完整段
 * 音频，并发只会在那一个 Worker 里排队，还多占内存。
 */
export async function contrastAll(
  samples: Float32Array, target: string, contrasts: Contrast[],
): Promise<ContrastVerdict[]> {
  const model = await loadModel();
  const out: ContrastVerdict[] = [];
  for (const c of contrasts) out.push(await decodeContrast(model, samples, target, c));
  return out;
}

