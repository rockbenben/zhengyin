/**
 * 说完自动停 —— 让「停止」那个按钮基本不需要按。
 *
 * 为什么值得做：那个按钮的名字怎么起都不对。「停止」含糊（停什么？），
 * 「念完了」是第一人称陈述、不像控件，「结束并评测」太长而且一天要点几十次。
 * 最好的答案是**这一下根本不用点**：按一次「录音」，念出来，它自己停。
 *
 * 只做单词和短语，所以规则可以很简单：
 *   ① 先用开头一小段估出本底噪声（**不用绝对门槛**——环境噪音大的时候绝对值会失灵，
 *      这跟 wav.ts 里剪静音的门槛是同一个道理）
 *   ② 等到能量明显高过本底，算"开始说话了"
 *   ③ 说过话之后再安静住 SILENCE_MS，就停
 *   ④ 兜底：一直没说话，NO_SPEECH_MS 后停；说了很久也在 MAX_MS 停
 *
 * 手动停止的按钮仍然留着——VAD 误判时得有退路，只是它从主路径变成了例外。
 */

/** 估本底噪声用开头这么久。太短会撞上说话起头，太长会让人等 */
const CALIBRATE_MS = 250;
/** 能量高过本底这么多倍算"在说话"。比剪静音用的 2.5 更宽松：这里宁可晚停，不可早停 */
const SPEECH_MARGIN = 3.5;
/** 说过话之后安静这么久就停。停顿短于此的塞音闭塞期不会误触 */
const SILENCE_MS = 700;
/** 一直没听到人声就放弃 */
const NO_SPEECH_MS = 5000;
/** 无论如何不超过这么久 */
const MAX_MS = 10000;
/** 本底再低也不低于这个值，免得在极安静环境里被一点点电噪触发 */
const FLOOR_MIN = 0.004;

export interface Endpointer {
  /** 停掉检测并释放音频节点。**必须调用**——AudioContext 不关会一直占着麦克风资源 */
  stop: () => void;
}

/**
 * 盯着这条流，判断"说完了"就调 onDone。
 *
 * @param onDone 说完了 / 超时了。参数说明为什么停的，调用方据此给不同提示
 */
export function detectEndOfSpeech(
  stream: MediaStream,
  onDone: (reason: 'done' | 'no-speech' | 'too-long') => void,
): Endpointer {
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  const started = performance.now();
  let floor = 0;
  let calibrating = true;
  const calSamples: number[] = [];
  let speechAt = 0;         // 第一次听到人声的时刻；0 = 还没听到
  let quietSince = 0;       // 说过话之后开始安静的时刻；0 = 当前不安静
  let raf = 0;
  let done = false;

  // 只 resolve 一次，并且**先关音频节点再回调**：回调里通常会 recorder.stop()，
  // 那之后这条流的轨道会被停掉，再去动 AudioContext 容易撞上已失效的节点。
  const finish = (reason: 'done' | 'no-speech' | 'too-long') => {
    if (done) return;
    done = true;
    cleanup();
    onDone(reason);
  };

  function cleanup() {
    cancelAnimationFrame(raf);
    try { src.disconnect(); } catch { /* 已经断开就算了 */ }
    // close() 返回 Promise，失败无所谓——反正这个 ctx 不再用了
    void ctx.close().catch(() => {});
  }

  const tick = () => {
    if (done) return;
    raf = requestAnimationFrame(tick);

    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    const now = performance.now();
    const elapsed = now - started;

    if (calibrating) {
      calSamples.push(rms);
      if (elapsed < CALIBRATE_MS) return;
      calibrating = false;
      // 取中位数而不是均值：校准这 250ms 里万一有一下咔哒声，均值会被拉高、
      // 门槛跟着抬上去，然后真的说话反而触发不了
      const sorted = [...calSamples].sort((a, b) => a - b);
      floor = Math.max(sorted[Math.floor(sorted.length / 2)], FLOOR_MIN);
      return;
    }

    const loud = rms > floor * SPEECH_MARGIN;

    if (!speechAt) {
      if (loud) speechAt = now;
      else if (elapsed > NO_SPEECH_MS) finish('no-speech');
      return;
    }

    if (loud) {
      quietSince = 0;
    } else if (!quietSince) {
      quietSince = now;
    } else if (now - quietSince > SILENCE_MS) {
      finish('done');
      return;
    }

    if (elapsed > MAX_MS) finish('too-long');
  };

  raf = requestAnimationFrame(tick);
  return { stop: () => { if (!done) { done = true; cleanup(); } } };
}
