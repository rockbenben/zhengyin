import { describe, it, expect } from 'vitest';
import { clipToWavBlob, trimSilence, analyze } from './wav';

const RATE = 16000;
const ms = (n: number) => Math.round((RATE * n) / 1000);

/** 前 leadMs 静音 + toneMs 有声 + 尾 tailMs 静音 */
function clip(leadMs: number, toneMs: number, tailMs: number, amp = 0.5): Float32Array {
  const out = new Float32Array(ms(leadMs) + ms(toneMs) + ms(tailMs));
  for (let i = 0; i < ms(toneMs); i++) {
    out[ms(leadMs) + i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * amp;
  }
  return out;
}

/**
 * 造一段音频：底噪 + 若干段（起点秒, 时长毫秒, 幅度）。
 * 比上面那个 clip() 灵活，用来造"语音之外还有杂音"的情形。
 */
function withSegments(totalSec: number, floor: number, segs: Array<[number, number, number]>) {
  const n = Math.floor(totalSec * RATE);
  const a = new Float32Array(n);
  // 固定的伪随机底噪：测试不能靠 Math.random，否则偶发失败没法复现
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) a[i] = rnd() * floor;
  for (const [atSec, msLen, amp] of segs) {
    const st = Math.floor(atSec * RATE);
    const en = Math.min(n, st + ms(msLen));
    for (let i = st; i < en; i++) a[i] += Math.sin((2 * Math.PI * 200 * i) / RATE) * amp;
  }
  return a;
}
const secOf = (x: Float32Array) => x.length / RATE;

/**
 * 剪辑必须按**段**判断，不能按"最外侧越界窗"。
 *
 * 原来的实现取第一个和最后一个越界窗，中间一切照留。于是末尾只要有任何一个短瞬态
 * （呼气、嘴唇开合、松鼠标的咔哒、桌面碰一下），中间几百毫秒静音就全被留下——
 * 而说完自动停本身就保证末尾有 700ms 静音。症状是剪出来的音频长得离谱。
 *
 * 实测（修之前 → 修之后）：
 *   末尾 20ms 瞬态   1.76s → 0.64s
 *   开头 20ms 瞬态   1.32s → 0.64s
 *   末尾 200ms 呼气  2.14s → 0.64s
 * 而闭塞期、短语停顿、词首弱擦音**一个都没被切**。
 */
describe('剪辑要按段判断，别被一声杂音带跑', () => {
  // 0.3s 处 400ms 语音，全长 2s（自动停会在末尾留 ~700ms）
  const SPEECH: Array<[number, number, number]> = [[0.3, 400, 0.3]];
  const CLEAN = 0.64;   // 400ms + 前后各 120ms

  it('干净的短词：剪到语音本身', () => {
    expect(secOf(analyze(withSegments(2, 0.002, SPEECH)).trimmed)).toBeCloseTo(CLEAN, 1);
  });

  it('末尾一个 20ms 瞬态不许把长度撑开', () => {
    const a = withSegments(2, 0.002, [...SPEECH, [1.8, 20, 0.05]]);
    expect(secOf(analyze(a).trimmed)).toBeCloseTo(CLEAN, 1);
  });

  it('开头一个 20ms 瞬态同样不许', () => {
    const a = withSegments(2, 0.002, [[0.1, 20, 0.05], [0.8, 400, 0.3]]);
    expect(secOf(analyze(a).trimmed)).toBeCloseTo(CLEAN, 1);
  });

  it('末尾 200ms 的呼气也要挡掉 —— 它比咔哒长，但很轻', () => {
    // 靠的是"看这一段最响的那一窗"：呼气整段都轻，够不到峰值的 15%
    const a = withSegments(2.5, 0.002, [...SPEECH, [1.6, 200, 0.025]]);
    expect(secOf(analyze(a).trimmed)).toBeCloseTo(CLEAN, 1);
  });

  it('词首的弱擦音必须留住 —— 幅度跟呼气一样轻，但它跟元音连在同一段里', () => {
    // /θ/ /f/ 只有元音的 8% 左右。**这一条是"别靠提高门槛解决问题"的守卫**：
    // 门槛一抬就把要练的音削掉了。
    const a = withSegments(2, 0.002, [[0.4, 120, 0.025], [0.52, 300, 0.3]]);
    const sec = secOf(analyze(a).trimmed);
    expect(sec).toBeGreaterThan(0.6);    // 弱擦音那 120ms 也在里面
  });

  it('词尾独立成段的弱擦音必须留住 —— 比如 desks 的 /s/，前面隔着闭塞期', () => {
    // **这一条才是"段内峰值门槛不能抬高"的真守卫。**上面那条（词首弱擦音）测不到它：
    // 那里弱擦音跟元音是连续的、本来就在同一段，段内峰值由元音撑着，门槛抬到 50%
    // 也照样通过——变异测试里「峰值门槛抬到 50%」因此活了下来。
    //
    // 真正会被削掉的是**自己单独成一段**的弱音：词尾 /s/ 前面有塞音闭塞期隔开，
    // 它那一段的峰值只有元音的 20% 上下。门槛一抬，词尾整个消失，
    // 而"音节结尾的辅音"恰恰是中文母语者最需要练的那一类。
    const a = withSegments(2, 0.002, [[0.3, 300, 0.3], [0.66, 100, 0.06]]);
    const sec = secOf(analyze(a).trimmed);
    // 语音从 0.3 到 0.76，前后各 120ms → 约 0.70s；被削掉词尾的话只剩约 0.54s
    expect(sec).toBeGreaterThan(0.64);
  });

  it('词内塞音闭塞期不许被当成两段切开', () => {
    const a = withSegments(2, 0.002, [[0.3, 150, 0.3], [0.53, 200, 0.3]]);
    expect(secOf(analyze(a).trimmed)).toBeGreaterThan(0.6);
  });

  it('短语里两个词中间的停顿要保留', () => {
    const a = withSegments(2.5, 0.002, [[0.3, 300, 0.3], [0.85, 300, 0.3]]);
    expect(secOf(analyze(a).trimmed)).toBeGreaterThan(1.0);
  });

  it('短语里第二个词更轻、且停顿超过延伸间隔 → 它必须自己当锚，不能被丢掉', () => {
    // **这一条才是"锚段响度门槛不能抬高"的守卫。**别的用例里，弱的部分都紧挨着元音，
    // 靠向两侧延伸就救回来了，所以门槛抬到 50% 也看不出差别——变异测试里那一条因此活着。
    //
    // 真正要靠门槛的是这种：第二个词离得远（停顿 300ms > GAP_MS 150ms），延伸够不着，
    // 它只能自己当锚。而它比第一个词轻（25%），门槛一抬就整个消失——
    // 短语的后半截被吞掉，而且界面上不会有任何提示。
    const a = withSegments(3, 0.002, [[0.3, 300, 0.3], [0.9, 300, 0.075]]);
    const sec = secOf(analyze(a).trimmed);
    // 语音从 0.3 延到 1.2，前后各 120ms → 约 1.14s；第二个词被丢掉的话只剩约 0.54s
    expect(sec).toBeGreaterThan(1.0);
  });

  it('纯数字静音（本底恰好为 0）不算"很吵"—— snrDb 的 0 是哨兵不是分数', () => {
    // snrDb 在 noiseFloor 为 0 时返回 0，那是"没有噪声可测"的哨兵值。
    // 把它当成"信噪比 0dB、极吵"的话，一段完全干净的录音会走进低信噪比的保守模式、
    // 白白多留 300ms。这个坑是加保守模式时真的踩进去的，靠已有的用例才发现。
    const a = new Float32Array(Math.floor(2 * RATE));       // 全零
    for (let i = 0; i < ms(400); i++) {
      a[ms(500) + i] = Math.sin((2 * Math.PI * 200 * i) / RATE) * 0.3;
    }
    const r = analyze(a);
    expect(r.noiseFloor).toBe(0);
    expect(r.snrDb).toBe(0);
    // 400ms 语音 + 前后各 120ms = 0.64s；被误判成"很吵"的话会变成 0.94s
    expect(secOf(r.trimmed)).toBeLessThan(0.75);
  });

  it('整段只有一声杂音 → 原样返回，绝不返回空', () => {
    // 返回空会让下游误以为"录了个寂静"，而不是"这段太轻"
    const a = withSegments(1.5, 0.002, [[0.5, 20, 0.05]]);
    expect(analyze(a).trimmed.length).toBe(a.length);
  });
});

describe('trimSilence', () => {
  it('cuts leading and trailing silence but keeps a pad around the speech', () => {
    const trimmed = trimSilence(clip(1000, 500, 1500));
    // 有声段 500ms，前后各留 120ms 缓冲 → 期望约 740ms，容差放宽到一个窗口
    const seconds = trimmed.length / RATE;
    expect(seconds).toBeGreaterThan(0.7);
    expect(seconds).toBeLessThan(0.82);
  });

  // 塞音的爆破前是**闭塞期，那段就是静音**（click 的 /k/、play 的 /p/）。缓冲区就是为它留的：
  // 剪到紧贴有声段会把爆破前的起音一起削掉，而那正是这个工具要练的东西。
  it('keeps enough head room to preserve a stop closure before the burst', () => {
    const trimmed = trimSilence(clip(1000, 300, 300));
    const head = (trimmed.length - ms(300)) / 2 / RATE;
    expect(head).toBeGreaterThanOrEqual(0.1);   // 至少 100ms
  });

  // 整段都在阈值下时必须原样返回。返回空数组会让下游误以为"录了一段寂静"，
  // 而真实情况是"这段太轻"——两者该给用户的提示完全不同。
  it('returns the input unchanged when everything is below the threshold', () => {
    const silent = new Float32Array(ms(800));
    expect(trimSilence(silent)).toHaveLength(silent.length);
  });

  it('handles an empty buffer without throwing', () => {
    expect(trimSilence(new Float32Array(0))).toHaveLength(0);
  });

  // 阈值是相对峰值的，所以整体很轻的录音不该被整段剪掉——只是响度低，不是没说话。
  it('still finds speech in a quiet recording', () => {
    const trimmed = trimSilence(clip(500, 400, 500, 0.02));
    expect(trimmed.length).toBeLessThan(ms(1400));
    expect(trimmed.length).toBeGreaterThan(ms(300));
  });
});

describe('clipToWavBlob', () => {
  it('writes a 16-bit mono 16kHz WAV header matching the sample count', async () => {
    const samples = new Float32Array(1000).fill(0.5);
    const blob = clipToWavBlob({ samples, sampleRate: RATE });
    expect(blob.type).toBe('audio/wav');

    const v = new DataView(await blob.arrayBuffer());
    const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);          // 单声道
    expect(v.getUint32(24, true)).toBe(RATE);       // 采样率
    expect(v.getUint16(34, true)).toBe(16);         // 位深
    expect(v.getUint32(40, true)).toBe(samples.length * 2);
    expect(blob.size).toBe(44 + samples.length * 2);
  });

  it('clamps out-of-range samples instead of wrapping around', async () => {
    const blob = clipToWavBlob({ samples: new Float32Array([2, -2]), sampleRate: RATE });
    const v = new DataView(await blob.arrayBuffer());
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
  });
});

// ── 噪声环境 ───────────────────────────────────────────────────────────────
// 原来的门槛只看峰值的 3%。录音一噪，那个值可能整个落在噪声里，于是"剪静音"名存实亡：
// 前后的噪声被当成语音留着，A/B 里两个发音被撑开，评测拿到的也是带头带尾的一段。

/** 造一段：前后是噪声，中间是语音 */
function noisyClip(noise: number, speech: number, sr = 16000) {
  const n = sr; // 1s
  const a = new Float32Array(n);
  // 用确定的伪随机，测试才可复现
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  for (let i = 0; i < n; i++) a[i] = rnd() * noise;
  for (let i = Math.floor(n * 0.4); i < Math.floor(n * 0.6); i++) a[i] = rnd() * speech;
  return a;
}

describe('analyze —— 噪声环境下的剪辑', () => {
  it('本底噪声明显时仍然剪得掉前后（门槛跟着噪声抬起来）', () => {
    const a = noisyClip(0.05, 0.5);
    const { trimmed } = analyze(a);
    // 语音只占中间 20%，加上前后各 120ms 的余量，剪完应当远短于原长
    expect(trimmed.length).toBeLessThan(a.length * 0.75);
    expect(trimmed.length).toBeGreaterThan(a.length * 0.15);
  });

  it('安静录音的行为跟以前一样（噪声门槛不该影响干净的录音）', () => {
    const a = noisyClip(0.0005, 0.5);
    const { trimmed } = analyze(a);
    expect(trimmed.length).toBeLessThan(a.length * 0.7);
  });

  it('词首的轻擦音不会被噪声门槛削掉（封顶在峰值 25% 就是为了挡这个）', () => {
    // 真实情形：thin / five / hot 这类词开头是个很轻的擦音，后面元音响得多，
    // 而且前面没有静音可供估本底。这时"本底"估出来的其实就是那个轻擦音——
    // 门槛若跟着抬到 2.5 倍，正好把要练的那个音整个切掉，评测随即报"漏了 /θ/"，
    // 而你其实发出来了。
    const n = 16000;
    const a = new Float32Array(n);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
    const soft = Math.floor(n * 0.25);
    for (let i = 0; i < soft; i++) a[i] = rnd() * 0.15;   // 轻擦音
    for (let i = soft; i < n; i++) a[i] = rnd() * 0.5;    // 元音
    // 开头那段必须留住：剪完的长度应当接近原长，而不是从元音才开始
    expect(analyze(a).trimmed.length).toBeGreaterThan(n * 0.9);
  });

  it('信噪比算得出来，而且噪声越大这个数越小', () => {
    const clean = analyze(noisyClip(0.0005, 0.5)).snrDb;
    const noisy = analyze(noisyClip(0.08, 0.5)).snrDb;
    expect(clean).toBeGreaterThan(noisy);
    expect(noisy).toBeGreaterThan(0);
  });

  it('本底用最安静那批窗的中位数，不用最小值', () => {
    // 最小值容易撞上某一帧恰好接近零的采样，把本底估成 0，
    // 门槛就退化回旧的纯峰值规则、噪声照样剪不掉。
    const a = noisyClip(0.05, 0.5);
    a.set(new Float32Array(160), 0);      // 头 10ms 强行置零
    expect(analyze(a).noiseFloor).toBeGreaterThan(0.01);
  });

  it('空输入不崩，各项为 0', () => {
    expect(analyze(new Float32Array(0))).toEqual({
      trimmed: new Float32Array(0), peak: 0, noiseFloor: 0, snrDb: 0,
    });
  });
});
