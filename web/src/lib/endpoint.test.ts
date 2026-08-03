import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectEndOfSpeech } from './endpoint';

// 说完自动停是个有定时行为、又持有 AudioContext 的东西——类型检查完全兜不住
// "说了一半被切掉"或者"AudioContext 没关"。这里把 Web Audio 和时间都换成假的来测。

let level = 0;              // 当前这一帧的 RMS，由测试驱动
let now = 0;                // 假时钟
let frames: Array<() => void> = [];
let closed = 0;
let disconnected = 0;

/** 推进假时钟并跑 n 帧（每帧 16ms，跟 rAF 差不多） */
function advance(ms: number, rms: number) {
  level = rms;
  const steps = Math.ceil(ms / 16);
  for (let i = 0; i < steps; i++) {
    now += 16;
    const due = frames;
    frames = [];
    for (const f of due) f();
  }
}

beforeEach(() => {
  level = 0; now = 0; frames = []; closed = 0; disconnected = 0;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => { disconnected += 1; } }; }
    createAnalyser() {
      return {
        fftSize: 1024,
        connect: () => {},
        // 造一段常量波形，其 RMS 恰好等于 level
        getFloatTimeDomainData: (b: Float32Array) => b.fill(level),
      };
    }
    close() { closed += 1; return Promise.resolve(); }
  });
});
afterEach(() => vi.unstubAllGlobals());

const fakeStream = {} as MediaStream;

describe('detectEndOfSpeech', () => {
  it('说话后安静下来就停，并且报 done', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.002);      // 校准：安静
    advance(500, 0.20);       // 说话
    expect(onDone).not.toHaveBeenCalled();
    advance(400, 0.002);      // 才安静 400ms，不该停（SILENCE_MS = 700）
    expect(onDone).not.toHaveBeenCalled();
    advance(500, 0.002);      // 累计超过 700ms
    expect(onDone).toHaveBeenCalledWith('done');
  });

  it('词中间的短停顿不会把话切断', () => {
    // 塞音的闭塞期就是静音（click 的 /k/、detox 的 /k/）。切早了会把爆破前那一段削掉，
    // 而那正是这个工具要练的东西。
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.002);
    advance(200, 0.20);       // 说
    advance(300, 0.002);      // 闭塞期 300ms
    advance(200, 0.20);       // 继续说
    expect(onDone).not.toHaveBeenCalled();
  });

  it('一直没人声 → 报 no-speech', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(6000, 0.002);
    expect(onDone).toHaveBeenCalledWith('no-speech');
  });

  it('说太久 → 报 too-long，不会无限录下去', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.002);
    advance(11000, 0.20);
    expect(onDone).toHaveBeenCalledWith('too-long');
  });

  it('本底噪声大时门槛跟着抬——不然吵环境里永远判不出"安静"', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.05);       // 校准时本底就是 0.05
    advance(500, 0.40);       // 说话
    advance(1200, 0.05);      // 回到本底 = 安静
    expect(onDone).toHaveBeenCalledWith('done');
  });

  it('校准期里一声咔哒不该把门槛抬飞', () => {
    // 本底若取均值：250ms 校准期里混进一帧 0.9 的咔哒声（碰麦克风、键盘），
    // 均值会被拉到 0.06 上下，门槛跟着抬到 0.2 以上——之后正常说话反而触发不了，
    // 结果是"没听到人声"。取中位数就不受这一帧影响。
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(16, 0.002);
    advance(16, 0.9);          // 一帧咔哒
    advance(300, 0.002);       // 校准期剩下的都是安静
    advance(400, 0.12);        // 正常说话音量
    advance(1200, 0.002);
    expect(onDone).toHaveBeenCalledWith('done');
  });

  it('本底之上但不够响的持续噪音不算说话', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.05);
    advance(6000, 0.10);      // 只有本底的 2 倍，低于 SPEECH_MARGIN(3.5)
    expect(onDone).toHaveBeenCalledWith('no-speech');
  });

  it('只回调一次，之后不再触发', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.002);
    advance(300, 0.20);
    advance(3000, 0.002);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('停下时一定关掉 AudioContext —— 不关会一直占着麦克风资源', () => {
    const onDone = vi.fn();
    detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.002);
    advance(300, 0.20);
    advance(1000, 0.002);
    expect(onDone).toHaveBeenCalledWith('done');
    expect(closed).toBe(1);
    expect(disconnected).toBe(1);
  });

  it('手动 stop() 也要关掉，并且不再回调', () => {
    const onDone = vi.fn();
    const ep = detectEndOfSpeech(fakeStream, onDone);
    advance(300, 0.002);
    advance(200, 0.20);
    ep.stop();
    expect(closed).toBe(1);
    advance(3000, 0.002);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('stop() 调两次不会重复关', () => {
    const ep = detectEndOfSpeech(fakeStream, vi.fn());
    ep.stop();
    ep.stop();
    expect(closed).toBe(1);
  });
});
