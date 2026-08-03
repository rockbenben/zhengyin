// 用**真人录音**验剪辑。合成正弦波测不出来的东西，这里能测出来。
//
// 为什么必须有这一层：合成音的能量分布太干净——一段响、其余静音。真语音不是那样。
// thought = /θɔt/ 的实测包络是
//   /θ/（<15% 峰值，90ms）— 元音（>40%，220ms）— 闭塞期（<2%，90ms）— /t/ 爆破（<15%，50ms）
// 词首擦音和词尾爆破都只有峰值的 10–15%，跟呼气（8% 上下）几乎分不开。
// 只按响度筛会把它们当杂音削掉——剪出来只剩元音。合成音里没有这种结构，所以测不到。
//
// 依赖 ffmpeg 和 data/audio 下的真人录音；缺任何一样就跳过（CI 或新克隆的仓库里没有它们，
// 那种情况下不该假红）。
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from './wav';

const SR = 16000;
const ROOT = join(import.meta.dirname, '..', '..', '..');
const AUDIO = join(ROOT, 'data', 'audio');

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** mp3 → 16k 单声道 float32，跟浏览器那条路的重采样目标一致 */
function decode(mp3: string): Float32Array {
  const buf = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', mp3, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/** 固定种子的伪随机底噪。不能用 Math.random：偶发失败没法复现 */
function noise(n: number, amp: number, seed: number): Float32Array {
  const a = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    a[i] = ((s / 0x7fffffff) * 2 - 1) * amp;
  }
  return a;
}

/**
 * 造出**真实的录音条件**：
 * 前 500ms 静音（按下录音到开口的反应时间）+ 语音 + 后 700ms 静音（说完自动停要等的那段，
 * 见 endpoint.ts 的 SILENCE_MS）+ 可选的末尾瞬态（呼气 / 碰麦克风 / 松鼠标）。
 */
function asRecorded(speech: Float32Array, click: boolean): Float32Array {
  const lead = noise(Math.floor(0.5 * SR), 0.0015, 7);
  const tail = noise(Math.floor(0.7 * SR), 0.0015, 99);
  if (click) {
    let peak = 0;
    for (const v of speech) peak = Math.max(peak, Math.abs(v));
    const amp = peak / 6;                      // 一次呼气/碰麦克风就是这个量级
    const at = Math.floor(0.3 * SR);
    for (let i = 0; i < Math.floor(0.02 * SR); i++) {
      tail[at + i] += Math.sin((2 * Math.PI * 150 * i) / SR) * amp;
    }
  }
  const out = new Float32Array(lead.length + speech.length + tail.length);
  out.set(lead, 0);
  out.set(speech, lead.length);
  out.set(tail, lead.length + speech.length);
  return out;
}

/**
 * **有真实时间结构的底噪**。真实录音里的底噪不是实验室白噪。
 *
 * 白噪是最好对付的一种噪声：10ms 窗上 441 个样本，窗 RMS 的相对标准差只有约 3.4%，
 * 平得像条直线。而本底估计取的是最低 10% 窗的中位数，于是 `noiseFloor × 1.3`
 * 相当于均值以上六个标准差——白噪永远够不着，**造不出一个杂散段**。
 * 用白噪测剪辑，等于把最会出问题的那一类噪声排除在外了。
 *
 * 真实房间底噪（风扇、空调、远处说话、键盘、窗外车流）的包络是**起伏的**：
 * 有缓慢漂移，也有突发。主流做法是拿 NOISEX-92 / MUSAN 这类噪声语料按指定信噪比叠加；
 * 这里没有语料库，就合成出同样的三个特征：
 *
 *   1. 缓慢漂移的包络（随机游走，0.5×–2×）—— 空调忽大忽小
 *   2. 每隔约 300ms 一次的突发（40ms，3 倍幅度）—— 键盘、桌面碰撞、远处一声
 *   3. 低频隆隆（55Hz）—— 风扇/市电，正好考一考 70Hz 的高通
 *
 * 突发那一项是关键：它会造出高于本底很多的短段，而"锚段必须过主门槛"和
 * "延伸相对锚段而不是逐段接力"这两条，正是拦它们的。
 */
function roomNoise(n: number, amp: number, seed: number, burstMs = 300): Float32Array {
  const a = new Float32Array(n);
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  let env = 1;
  const burstEvery = Math.floor((burstMs / 1000) * SR);
  for (let i = 0; i < n; i++) {
    if (i % 256 === 0) env = Math.min(2, Math.max(0.5, env + (rand() - 0.5) * 0.3));
    const inBurst = i % burstEvery < Math.floor(0.04 * SR);
    const rumble = Math.sin((2 * Math.PI * 55 * i) / SR) * 0.4;
    a[i] = ((rand() * 2 - 1) * env * (inBurst ? 3 : 1) + rumble) * amp;
  }
  return a;
}

/**
 * 从**干净信号**取真值标注：语音真正的起止（相对整段的秒）。
 *
 * 这是加噪鲁棒性评测的标准做法——标注来自干净版本，测试跑在加噪版本上。
 * 用 3% 峰值这个很松的门槛，尽量把弱辅音也算进语音。
 */
function voicedBounds(speech: Float32Array): { from: number; to: number } {
  const win = Math.floor(SR * 0.01);
  const rms: number[] = [];
  for (let i = 0; i + win <= speech.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += speech[j] * speech[j];
    rms.push(Math.sqrt(sum / win));
  }
  const peak = Math.max(...rms);
  const thr = peak * 0.03;
  const first = rms.findIndex((v) => v >= thr);
  let last = rms.length - 1;
  while (last > first && rms[last] < thr) last--;
  return { from: (first * win) / SR, to: ((last + 1) * win) / SR };
}

/**
 * VAD 的经典四类误差里，这里用得上的两类（另两类是词内切断和噪声当语音）：
 *   FEC  front-end clipping —— 开头切进语音了多少（>0 就是切了，一定要是 0）
 *   OVER                    —— 语音之外多留了多少静音（可以有，但不能无限）
 * **分开量是关键**：只比总长度的话，前面切 100ms、后面多留 100ms 会互相抵消，
 * 总长看着正好，而实际上开头的辅音已经没了。两个"留得更多"的变异就是这么漏过去的。
 */
function errors(buf: Float32Array, speechFrom: number, speechTo: number) {
  const trimmed = analyze(buf).trimmed.length / SR;
  // analyze 只返回剪完的长度，起点要反推：它是 [start, stop)，而我们知道整段长度
  // 与保留时长，配合"剪辑只从两头切"这个性质，用一次二分即可定位起点。
  // 更简单可靠的办法：直接找剪出来的那段在原段里的位置。
  const a = analyze(buf).trimmed;
  let start = 0;
  for (let i = 0; i + a.length <= buf.length; i++) {
    if (buf[i] === a[0] && buf[i + a.length - 1] === a[a.length - 1]) { start = i; break; }
  }
  const from = start / SR;
  const to = from + trimmed;
  return {
    fecMs: Math.max(0, from - speechFrom) * 1000,        // 开头切进语音
    tailClipMs: Math.max(0, speechTo - to) * 1000,       // 结尾切进语音
    overHeadMs: Math.max(0, speechFrom - from) * 1000,   // 开头多留的静音
    overTailMs: Math.max(0, to - speechTo) * 1000,       // 结尾多留的静音
  };
}

const WORDS = ['click', 'book', 'night', 'glass', 'thought', 'dopamine'];
const available = hasFfmpeg()
  ? WORDS.filter((w) => existsSync(join(AUDIO, `${w}-mw.mp3`)))
  : [];

describe.skipIf(available.length === 0)('真人录音的剪辑', () => {
  for (const w of available) {
    for (const click of [false, true]) {
      it(`${w}${click ? '（末尾还有一声杂音）' : ''} 剪回语音本身的长度`, () => {
        const speech = decode(join(AUDIO, `${w}-mw.mp3`));
        const trimmed = analyze(asRecorded(speech, click)).trimmed.length / SR;
        const want = speech.length / SR + 0.24;     // 语音 + 前后各 120ms 缓冲
        // 容差 150ms：真人录音自己首尾也带一点空白，剪掉那部分是对的
        expect(Math.abs(trimmed - want)).toBeLessThan(0.15);
      });
    }
  }

  /**
   * 底噪扫描。真实录音的底噪常常不低。
   *
   * 之前所有测试的底噪都是 0.0015（SNR 45dB，近乎理想）。按真实底噪扫一遍才发现：
   * 20–30dB 这一带会**静默切掉语音**，切的正是 /θ/ /t/ 这些最弱的音——
   * 于是工具报"漏了 /θ/"，而人其实念了。**凭空造出一个不存在的发音问题，
   * 是这个工具最坏的一种错。**
   *
   * 实测的失守点（thought）：单门槛 29dB → 双门槛 19.5dB → 加上低信噪比保守模式后不再失守。
   *
   * 这一条只断言一个方向：**任何信噪比下都不许切掉语音**。多留是允许的——
   * 评测那头多几十毫秒噪声无所谓，少留就是一个假错误。
   */
  it('从干净到很吵，任何信噪比下都不许切掉语音', () => {
    for (const w of available) {
      const speech = decode(join(AUDIO, `${w}-mw.mp3`));
      // 语音本身的 rms，用来按目标 SNR 反推底噪幅度
      let sum = 0;
      let n = 0;
      for (const v of speech) { if (Math.abs(v) > 0.01) { sum += v * v; n++; } }
      const srms = n ? Math.sqrt(sum / n) : 0;

      for (const snr of [45, 30, 25, 20, 15, 10, 5]) {
        // 均匀分布白噪的 rms ≈ amp/√3
        const amp = (srms / Math.pow(10, snr / 20)) * Math.sqrt(3);
        const lead = Math.floor(0.5 * SR);
        const tail = Math.floor(0.7 * SR);
        // 整段都铺底噪 —— 真实录音就是这样，噪声不会只在静音段出现
        const buf = noise(lead + speech.length + tail, amp, 7);
        for (let i = 0; i < speech.length; i++) buf[lead + i] += speech[i];

        const got = analyze(buf).trimmed.length / SR;
        const want = speech.length / SR + 0.24;
        // 只卡下界：切掉语音才是错，多留不是
        expect(got, `${w} @ ${snr}dB 切掉了语音`).toBeGreaterThan(want - 0.15);
      }
    }
  }, 120000);

  /**
   * 上界。上面那条只卡"不许切掉语音"，而**多留到极端就是剪辑彻底失效**——
   * 整段照留的话，A/B 对比会被前后一两秒空白撑开，两个发音挨不到一起，
   * 而那正是剪辑存在的全部理由。
   *
   * 这一条是变异测试逼出来的：两个让它"留得更多"的变异（锚段不再要求过主门槛、
   * 延伸改回逐段接力）在只有下界时全都活着。逐段接力在底噪大时尤其危险——
   * 段与段首尾相接，会一路接力到整段音频的两头。
   */
  it('按 VAD 的误差分类量：任何信噪比下都不许切进语音，多留也有上限', () => {
    // 这一条替代了"只比总长度"的写法。分开量首尾之后，
    // 两个"留得更多"的变异（锚段不再要求过主门槛、延伸改回逐段接力）才拦得住——
    // 它们不切语音，但会把静音一路留到两头。
    for (const w of available) {
      const speech = decode(join(AUDIO, `${w}-mw.mp3`));
      const b = voicedBounds(speech);
      let sum = 0;
      let n = 0;
      for (const v of speech) { if (Math.abs(v) > 0.01) { sum += v * v; n++; } }
      const srms = n ? Math.sqrt(sum / n) : 0;

      for (const snr of [45, 30, 25, 20, 15, 10]) {
        // 两种底噪都要扛：平坦白噪（好对付）和有突发的真实房间噪声（难对付）
        // 三种底噪都要扛：
        //   白噪   —— 平坦，窗 RMS 几乎不起伏，最好对付
        //   房间   —— 缓慢漂移 + 每 300ms 一次突发（空调、远处一声）
        //   密集   —— 每 120ms 一次突发（打字、雨声、翻纸）。间隔小于延伸容许的
        //             150ms，**段与段首尾相接**，正是"延伸不逐段接力"要拦的那一种
        for (const kind of ['白噪', '房间', '密集'] as const) {
          const gen =
            kind === '白噪'
              ? noise
              : kind === '房间'
                ? (n: number, a: number, sd: number) => roomNoise(n, a, sd)
                : (n: number, a: number, sd: number) => roomNoise(n, a, sd, 120);
          const amp = (srms / Math.pow(10, snr / 20)) * Math.sqrt(3);
          const lead = 0.5;
          const buf = gen(Math.floor((lead + speech.length / SR + 0.7) * SR), amp, 7);
          for (let i = 0; i < speech.length; i++) buf[Math.floor(lead * SR) + i] += speech[i];

          const e = errors(buf, lead + b.from, lead + b.to);
          const tag = `${w} @ ${snr}dB ${kind}`;
        // 切进语音 = 凭空造出"漏了某个音"，一毫秒都不许（给 20ms 的窗口误差余量）
          expect(e.fecMs, `${tag} 开头切进语音 ${e.fecMs.toFixed(0)}ms`).toBeLessThan(20);
          expect(e.tailClipMs, `${tag} 结尾切进语音 ${e.tailClipMs.toFixed(0)}ms`).toBeLessThan(20);
          // 多留是**次要的坏**：留进来的突发可能被识别器读成一个多余的音素。
          // 但它远不如切掉语音严重，所以这里只当防回归的护栏，不当精度指标。
          //
          // 实测（突发型房间底噪，45→10dB）：干净时头尾各多留 120–190ms；
          // 底噪一大就平在头 ~510ms、尾最多 ~750ms——**平**说明是撞到了设计的天花板
          // （延伸上限 200ms + 缓冲 120ms + 低信噪比再加 150ms），不是失控。
          // 这是当前已知的弱点，写在这儿是为了它变坏时有人知道。
          expect(e.overHeadMs, `${tag} 开头多留 ${e.overHeadMs.toFixed(0)}ms`).toBeLessThan(800);
          expect(e.overTailMs, `${tag} 结尾多留 ${e.overTailMs.toFixed(0)}ms`).toBeLessThan(800);
        }
      }
    }
  }, 120000);

  it('中等底噪下剪辑仍然要起作用，不能退化成整段照留', () => {
    for (const w of available) {
      const speech = decode(join(AUDIO, `${w}-mw.mp3`));
      let sum = 0;
      let n = 0;
      for (const v of speech) { if (Math.abs(v) > 0.01) { sum += v * v; n++; } }
      const srms = n ? Math.sqrt(sum / n) : 0;
      const amp = (srms / Math.pow(10, 25 / 20)) * Math.sqrt(3);   // 25dB：普通房间
      const lead = Math.floor(0.5 * SR);
      const tail = Math.floor(0.7 * SR);
      const buf = noise(lead + speech.length + tail, amp, 7);
      for (let i = 0; i < speech.length; i++) buf[lead + i] += speech[i];

      const got = analyze(buf).trimmed.length / SR;
      const full = buf.length / SR;
      // 前后共 1.2s 静音，至少要剪掉大半。留够语音 + 缓冲即可，别把静音也带上
      expect(got, `${w} 剪辑失效了，几乎整段照留`).toBeLessThan(full - 0.6);
    }
  });


  it('加不加末尾那声杂音，剪出来必须一样长', () => {
    // 这一条是本体：剪出来的音频长得离谱。
    for (const w of available) {
      const speech = decode(join(AUDIO, `${w}-mw.mp3`));
      const clean = analyze(asRecorded(speech, false)).trimmed.length;
      const dirty = analyze(asRecorded(speech, true)).trimmed.length;
      expect(Math.abs(clean - dirty) / SR, `${w}`).toBeLessThan(0.02);
    }
  });
});
