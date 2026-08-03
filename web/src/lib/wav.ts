// 录音后处理：解码 → 重采样 16kHz 单声道 → 保守剪掉前后静音。
//
// 只解码一次，产出的样本同时供两处使用：评测（直接吃 Float32Array）和 A/B 对比（编码成
// WAV 播放）。这样"听到的"和"送去识别的"是同一段音频，不会出现「评测说没听清、可 A/B
// 里明明有声音」这种自相矛盾。
//
// 录音全程留在浏览器内存/Blob URL 里，不生成、不上传任何音频文件。

export interface Clip {
  samples: Float32Array;
  sampleRate: 16000;
  /** 语音峰值（剪之前整段的最大窗 RMS） */
  peak: number;
  /** 本底噪声（最安静的那批窗的 RMS） */
  noiseFloor: number;
  /** 信噪比 dB。噪声真的大不大，用这个数说话，不靠感觉 */
  snrDb: number;
}

const SAMPLE_RATE = 16000;

// 剪静音的两个参数，都刻意保守：
// - 阈值取峰值的 3%（且有绝对下限，避免整段极轻时把有效声音也当静音）
// - 前后各留 120ms 缓冲
//
// 为什么必须保守：塞音的爆破之前是**闭塞期，那段就是静音**。click 的 /k/、play 的 /p/
// 都是先闭后爆。剪狠了会把爆破前的闭塞连同起音一起削掉——而那恰恰是这个工具要练的东西。
const SILENCE_RATIO = 0.03;
const SILENCE_FLOOR = 0.005;
const PAD_MS = 120;
const WINDOW_MS = 10;

// 门槛至少要高出本底噪声这么多倍。
// 原来只按峰值的 3% 定门槛：录音一噪，那个值可能整个落在噪声里，于是"剪静音"名存实亡——
// 前后的噪声被当成语音留着，A/B 对比里两个发音又被撑开，评测拿到的也是带头带尾的一段。
const NOISE_MARGIN = 2.5;
// 但噪声门槛不能无限抬：整段都是语音、没有安静段落时，"本底"估出来的其实是语音，
// 门槛跟着飙上去就会把真正的起音削掉。封顶在峰值的 25%。
const NOISE_CEIL_RATIO = 0.25;

// 高通截止。人声基频最低的男声也在 85Hz 上下，70Hz 以下基本只有空调声、桌面震动、
// 手碰麦克风这类东西——切掉它们纯赚：既不动语音，又把本底噪声压下来，
// 连带让上面那个门槛估得更准。
const HIGHPASS_HZ = 70;

// ── 哪些越界段算"语音"，哪些是杂音 ──
//
// 原来的剪法是取**最外侧**的越界窗：第一个超过门槛的窗到最后一个超过门槛的窗，
// 中间一切照留。于是末尾只要有**任何一个**短瞬态（呼气、嘴唇开合、松鼠标的咔哒、
// 桌面碰一下），last 就跳到那儿，中间几百毫秒静音全被留下——而自动停本身就保证
// 末尾有 700ms 静音。实测：一个 20ms、幅度只有语音 1/6 的瞬态，
// 把 0.64s 的短词撑成 1.76s——剪出来的音频长得离谱，就是这个原因。
//
// **不能靠提高门槛来解决**：/θ/ /f/ 这类擦音本来就很弱，门槛一抬就把要练的音削掉了
// （这个文件顶上早写过同样的警告）。所以改成按**段**判断：
//   · 太短的段丢掉——真语音段总是跟前后的元音连在一起，长得多；孤立瞬态只有 5–40ms
//   · 太轻的段丢掉——**看这一段最响的那一窗**，不是看每一窗。词首的弱擦音跟后面的元音
//     在同一段里，那一段的峰值是元音撑起来的，所以不会被误杀；而孤立的呼气整段都轻
// **只按响度筛是不够的**，真人录音上量出来了：thought 的包络是
//   /θ/（<15%，90ms）— 元音（>40%，220ms）— 闭塞期（<2%，90ms）— /t/ 爆破（<15%，50ms）
// 开头的 /θ/ 和结尾的 /t/ 都只有峰值的 10–15%，跟呼气（8% 上下）几乎分不开。
// 只按响度筛的话，剪出来 0.46s——只剩元音，**词首擦音和词尾爆破全被削掉**。
// 而"音节结尾的辅音"恰恰是中文母语者第一号短板（美音要点 第 1 条）。
//
// 真正分得开的是**距离**：词尾爆破离元音只隔一个闭塞期（~100ms），呼气离得远。所以分两步：
//   ① 先找"锚段"——够长（MIN_RUN_MS）且够响（ANCHOR_RATIO）的段，那必然是语音
//   ② 再从锚段向两侧**延伸**：只要下一段的间隔小于 GAP_MS，就把它并进来，不管它多轻多短
// 于是 thought 的 /θ/（间隔 40ms）和 /t/（间隔 100ms）都被收回来，
// 而 1 秒之外的呼气、咔哒够不着，仍然被挡在外面。
const MIN_RUN_MS = 50;
const ANCHOR_RATIO = 0.15;
const GAP_MS = 150;

// **锚段要严，延伸可以松。**
// 底噪一大，/θ/ /t/ 这些只有峰值 10–15% 的段就沉到主门槛以下，连"段"都不成立，
// 延伸自然够不着。实测（真人录音加白噪）：thought 在 29dB 就开始被切掉 0.22s，
// 24dB 切 0.35s。切掉的正是词首擦音和词尾爆破——工具于是报"漏了 /θ/"，而人其实念了。
// **这是最坏的一种错：凭空造出一个不存在的发音问题。**
//
// 解法不是把门槛整体调松（那样锚段也会被杂音顶替），而是**两个门槛**：
//   · 锚段用主门槛——必须确凿是语音
//   · 延伸用这个更低的门槛——锚段旁边只要还有点东西，就认为可能是弱辅音，收进来
// 噪声里 /θ/ 仍然在本底之上，只是够不到主门槛，所以这一层正好能捞回它。
// 延伸的总量被 GAP_MS 卡死（相对**原始锚段**，不是逐段接力），所以最坏也只多留 150ms。
const EXTEND_FLOOR_MARGIN = 1.3;

// 双门槛把失守点从 29dB 压到了 19.5dB（实测）。再往下，弱辅音连本底的 1.3 倍都够不到，
// 数据里是真的看不见了——这时候不该继续硬猜边界，该承认看不见、往外多留一段。
// 20dB 这个界跟界面上那句"背景噪音偏大，识别结果会不稳"是同一个门槛
// （Recorder.tsx 的 LOW_SNR_DB）：警告出现的那一刻，剪辑也同时转成保守模式。
// 多留的代价只是片段长一点（评测那头多几十毫秒噪声无所谓），少留的代价是一个假错误。
const NOISY_SNR_DB = 20;

/**
 * 剪掉前后静音。整段都在阈值之下（没录到东西/全是底噪）时原样返回，
 * 绝不返回空数组——那会让下游误以为"录了个寂静"，而不是"这段太轻"。
 */
export function trimSilence(samples: Float32Array, sampleRate = SAMPLE_RATE): Float32Array {
  return analyze(samples, sampleRate).trimmed;
}

export interface Analysis {
  trimmed: Float32Array;
  peak: number;
  noiseFloor: number;
  snrDb: number;
}

/** 逐 10ms 窗的 RMS。看单个样本的话，一次键盘声就会被当成语音起点 */
function windowRms(samples: Float32Array, win: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(i + win, samples.length);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / (end - i)));
  }
  return out;
}

/**
 * 本底噪声：取最安静的那 10% 窗的中位数。
 * 用中位数而不是最小值——最小值容易撞上某一帧恰好接近零的采样，把本底估成 0，
 * 门槛就退化回旧的纯峰值规则了。
 */
function estimateNoiseFloor(rms: number[]): number {
  const sorted = [...rms].sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(sorted.length * 0.1));
  return sorted[Math.floor(n / 2)];
}

export function analyze(samples: Float32Array, sampleRate = SAMPLE_RATE): Analysis {
  if (samples.length === 0) {
    return { trimmed: samples, peak: 0, noiseFloor: 0, snrDb: 0 };
  }

  const win = Math.max(1, Math.floor((sampleRate * WINDOW_MS) / 1000));
  const rms = windowRms(samples, win);

  const peak = Math.max(...rms);
  const noiseFloor = estimateNoiseFloor(rms);
  const snrDb = noiseFloor > 0 && peak > 0 ? 20 * Math.log10(peak / noiseFloor) : 0;

  const threshold = Math.min(
    Math.max(peak * SILENCE_RATIO, SILENCE_FLOOR, noiseFloor * NOISE_MARGIN),
    peak * NOISE_CEIL_RATIO,
  );

  // 先切成"连续越界段"，再逐段判断它是不是语音（理由见 MIN_RUN_MS 那段注释）。
  // **切段用的是延伸门槛（更低）**，这样底噪大时弱辅音仍然成段、延伸那一步才捞得回来；
  // 是不是锚段另外按主门槛和响度判。
  const extThreshold = Math.max(noiseFloor * EXTEND_FLOOR_MARGIN, SILENCE_FLOOR * 0.6);
  const minWins = Math.max(1, Math.round(MIN_RUN_MS / WINDOW_MS));
  const runs: Array<{ from: number; to: number; max: number }> = [];
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < extThreshold) continue;
    let j = i;
    let mx = 0;
    while (j < rms.length && rms[j] >= extThreshold) { mx = Math.max(mx, rms[j]); j++; }
    runs.push({ from: i, to: j - 1, max: mx });
    i = j;
  }
  // ① 锚段：够长且够响，必然是语音
  const anchors = runs.filter(
    (r) => r.to - r.from + 1 >= minWins && r.max >= peak * ANCHOR_RATIO && r.max >= threshold,
  );

  // 整段都在门槛下，或者没有一段够长够响（只录到几声杂音）：原样返回，
  // 绝不返回空数组——那会让下游误以为"录了个寂静"，而不是"这段太轻"
  if (anchors.length === 0) return { trimmed: samples, peak, noiseFloor, snrDb };

  // ② 从锚段向两侧延伸，把紧挨着的弱段并进来（词首擦音、词尾爆破就在这儿被收回来）
  // 延伸的边界相对**原始锚段**算，不是逐段接力——否则底噪大时段与段首尾相接，
  // 会一路接力到整段音频的两头，"剪静音"就名存实亡了。
  const maxGap = Math.max(1, Math.round(GAP_MS / WINDOW_MS));
  const anchorFirst = anchors[0].from;
  const anchorLast = anchors[anchors.length - 1].to;
  let first = anchorFirst;
  let last = anchorLast;
  for (const r of runs) {
    if (r.to < anchorFirst && anchorFirst - r.to <= maxGap) first = Math.min(first, r.from);
    if (r.from > anchorLast && r.from - anchorLast <= maxGap) last = Math.max(last, r.to);
  }
  // 底噪大到看不见弱辅音时，多留 GAP_MS——那正是弱辅音可能藏着的宽度。
  // **必须先确认 noiseFloor > 0**：snrDb 在算不出时返回 0（见上面它的算式），
  // 那是"没有噪声可测"的哨兵，不是"信噪比 0dB、极吵"。分不清的话，
  // 一段纯数字静音里的录音会被当成最吵的情形处理——现成的测试正是这么抓到的。
  const noisy = noiseFloor > 0 && snrDb < NOISY_SNR_DB;
  const pad = Math.floor((sampleRate * (PAD_MS + (noisy ? GAP_MS : 0))) / 1000);
  const start = Math.max(0, first * win - pad);
  const stop = Math.min(samples.length, (last + 1) * win + pad);
  return { trimmed: samples.slice(start, stop), peak, noiseFloor, snrDb };
}

/** MediaRecorder 的 Blob（Chrome 下通常是 webm/opus）→ 16kHz 单声道、高通滤过、已剪静音的样本 */
export async function blobToClip(blob: Blob): Promise<Clip> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await ctx.close();
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const off = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;

  // 高通：切掉 70Hz 以下的空调声、桌面震动、手碰麦克风。那一段里没有语音，
  // 留着只会抬高本底噪声、让剪静音的门槛估不准。
  // 刻意**只做这一步**，不做频谱降噪：谱减法会引入音乐噪声，而擦音（/s/ /θ/ /ʃ/ /f/）
  // 本身就是噪声，降噪很容易连它一起削掉——对识别是帮倒忙。
  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = HIGHPASS_HZ;
  hp.Q.value = 0.707;              // Butterworth，通带不起包

  src.connect(hp);
  hp.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();

  const { trimmed, peak, noiseFloor, snrDb } = analyze(rendered.getChannelData(0));
  return { samples: trimmed, sampleRate: SAMPLE_RATE, peak, noiseFloor, snrDb };
}

/**
 * 把样本编成 WAV Blob 供 <audio> 播放。A/B 对比必须播**剪过的**这一份：原始录音前后
 * 各挂一两秒空白的话，"你的录音 → 停 300ms → 参考音"实际会隔开好几秒，两个发音挨不到
 * 一起，A/B 就失去意义了。
 */
export function clipToWavBlob({ samples, sampleRate }: Pick<Clip, 'samples' | 'sampleRate'>): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);        // PCM 头长度
  v.setUint16(20, 1, true);         // PCM
  v.setUint16(22, 1, true);         // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);  // 字节率
  v.setUint16(32, 2, true);         // 块对齐
  v.setUint16(34, 16, true);        // 位深
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
