/**
 * 纸与墨：主题（浅/深/跟随系统）和第二版油墨的颜色。两项都只存在本机浏览器里。
 *
 * 能换的只有第二版油墨——黑版、纸、红（破坏性操作）、琥珀（提醒）都是**语义**，
 * 换了会说错话。
 *
 * **只放开色相，亮度和彩度钉死。** OKLCH 的 L 是感知亮度，固定 L 就等于固定"多深"，
 * 转色相不会让它变浅变深，于是任何色相都落在同一条可读性水平线上——构造上就坏不了，
 * 不靠事后检查（检查照样做，见 ink.test.ts）。直接让人挑 hex 就没这个保证：
 * 挑一版浅黄，"你发的音"在纸上就没了。
 *
 * L/C 量自现有那两版蓝（#1b3fa8 / #8aa5ea），所以默认色相算出来就是原来那个颜色。
 * 公式是 Björn Ottosson 的 oklab，标准实现。
 */

/** 一版油墨在某个主题下的两个色值 */
export interface Ink {
  /** 蓝版本体：音素格、链接、焦点框 */
  ink: string;
  /** 淡网点：命中底纹、悬停行、Segmented 选中底 */
  soft: string;
}

/**
 * 默认色相 = 现有那两版蓝的色相（浅色 264.9°、深色 267.4°，取中）。
 * 群青，凸版印刷里最常见的第二版油墨。
 */
export const DEFAULT_HUE = 266;

/**
 * 每套纸上的坐标，量自现有调色板：
 *   浅色 blue #1b3fa8 → L .415 C .174   blueSoft #e7ecf8 → L .943 C .017
 *   深色 blue #8aa5ea → L .729 C .105   blueSoft #232838 → L .279 C .031
 * 改这几个数就是改"墨有多深、多艳"，跟色相无关。
 */
const COORDS = {
  light: { ink: { L: 0.415, C: 0.174 }, soft: { L: 0.943, C: 0.017 } },
  dark: { ink: { L: 0.729, C: 0.105 }, soft: { L: 0.279, C: 0.031 } },
} as const;

// ── OKLab ↔ sRGB（Ottosson 的标准公式）──────────────────────────────────

const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH → 线性 sRGB。可能落在 [0,1] 之外——那表示这个色相在这个亮度下超出了色域 */
function oklchToLinear(L: number, C: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

const hex = (rgb: number[]) => `#${rgb
  .map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255).toString(16).padStart(2, '0'))
  .join('')}`;

/**
 * OKLCH → hex，**超出色域时降彩度而不是砍通道**。
 *
 * 这一步不能省。同一个 L 下，不同色相能达到的最大彩度差很多——蓝紫能到 0.17，
 * 而黄绿在同样深浅下远达不到。直接把通道 clamp 进 [0,1] 会连亮度一起改掉
 * （砍掉一个通道就是在改亮度），那正好毁掉"固定 L 保证可读性"这条前提。
 * 二分降 C 则只丢彩度、保住 L——颜色会灰一点，但深浅不变，对比度就还在。
 */
function toHex(L: number, C: number, hue: number): string {
  let rgb = oklchToLinear(L, C, hue);
  if (inGamut(rgb)) return hex(rgb);
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, hue))) lo = mid;
    else hi = mid;
  }
  rgb = oklchToLinear(L, lo, hue);
  return hex(rgb);
}

/**
 * 色相归一到 [0,360)。**只认真正的数字**，别的一律回默认。
 *
 * 不要用 `Number(h)` 兜底：`Number(null)` 是 0，而 0 是个合法色相（红），
 * 于是一个坏值会静悄悄地变成一版红墨，还看不出是哪儿来的。
 */
export function normalizeHue(h: unknown): number {
  if (typeof h !== 'number' || !Number.isFinite(h)) return DEFAULT_HUE;
  return ((h % 360) + 360) % 360;
}

/** 这个色相在这套纸上的蓝版和淡网点 */
export function inkFor(hue: number, dark: boolean): Ink {
  const c = dark ? COORDS.dark : COORDS.light;
  const h = normalizeHue(hue);
  return { ink: toHex(c.ink.L, c.ink.C, h), soft: toHex(c.soft.L, c.soft.C, h) };
}

/**
 * 备好的几版油墨。**只给这几款，没有自由取色器**——给了就得回答"挑了一版浅黄怎么办"。
 * 每款只存一个色相，两套纸上的实际色值由 inkFor 算，加新墨只加一个数。
 *
 * **全是冷色是量出来的**：暖色半圈已经被语义占着（琥珀=提醒、红=破坏性操作），
 * 落进去就会跟那两个信号撞。按 OKLab 距离全色相扫一遍，离两个语义色都 ≥0.12 的
 * 只有 **145°–319°**（绿—青—蓝—紫）。肉眼挑会漏——赭石在深色纸上离琥珀只有 0.045，
 * 而那已经是"看不出区别"的量级，但在浅色纸上看着没问题。
 *
 * 判据写成了测试（ink.test.ts），加新墨会自动被检查。也放不下第五款：L 钉在 0.415 时
 * 绿—青那段彩度被色域压得很扁，再塞只会得到一款重复的墨。
 */
export const PRESETS: Array<{ name: string; hue: number }> = [
  { name: '群青', hue: DEFAULT_HUE },
  { name: '孔雀蓝', hue: 220 },
  { name: '铜绿', hue: 165 },
  { name: '紫', hue: 300 },
];

const KEY = 'overprint.hue';

/**
 * 读存下来的色相。没存过、存的是坏值、**或者那款墨已经不在墨屉里了**，都回默认。
 *
 * 最后一条是这次删掉三款墨时补的：挑过赭石的人，升级之后存着的还是 60°，
 * 界面上却没有哪一款是选中的——一个既看不见又改不掉的状态。
 * 墨屉就是全部词汇表，不在屉里的值一律当没存过。
 */
export function loadHue(): number {
  try {
    // 不再先 normalizeHue：**"必须在屉里"把它整个吞掉了**。
    // 归一化只多认一种输入（-94 也算群青），而没有任何路径会产生那种值——
    // saveHue 存的就是墨屉里的数。杀不掉的分支就是多余的分支。
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_HUE;
    const hue: unknown = JSON.parse(raw);
    return PRESETS.some((p) => p.hue === hue) ? (hue as number) : DEFAULT_HUE;
  } catch {
    return DEFAULT_HUE;
  }
}

/**
 * 存色相。localStorage 满了/被禁用时静默失败——换个墨色而已，不该弹错。
 *
 * **这里不校验**：loadHue 只认墨屉里的值，写这边再挡一道是第二处判据。
 * 杀不掉的分支就是多余的分支。
 */
export function saveHue(hue: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(hue));
  } catch {
    /* 存不下就这次生效、下次回默认，不打断使用 */
  }
}

// ────────────────────────────────────────────────────────────────────────
// 纸：浅色还是深色
// ────────────────────────────────────────────────────────────────────────

/**
 * 用哪套纸。`system` 跟随操作系统，另外两个是手动指定。
 *
 * 为什么要有手动这一档：原来只跟随系统，而设置页的预览摆着「浅色纸/深色纸」两块，
 * 看着像能挑——使用者当场问「浅色纸是浅色主题吗，怎么没地方切换」。
 * 而且这是个真需求：系统在深色、但想在亮房间里用浅色纸看，本来就该能改。
 *
 * **默认仍是跟随系统**，不是记住某一套：多数时候系统的设置就是对的，
 * 而且深浅通常跟着一天的时间走，钉死反而要人手动来回切。
 */
export type PaperPref = 'system' | 'light' | 'dark';

const PAPER_KEY = 'overprint.paper';
const PAPERS: PaperPref[] = ['system', 'light', 'dark'];

/** 读存下来的纸。没存过、或存的不是这三个值之一，都回「跟随系统」 */
export function loadPaper(): PaperPref {
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    if (raw === null) return 'system';
    const v: unknown = JSON.parse(raw);
    return PAPERS.includes(v as PaperPref) ? (v as PaperPref) : 'system';
  } catch {
    return 'system';
  }
}

/** 存纸。跟 saveHue 一样，存不下就静默失败，不打断使用 */
export function savePaper(p: PaperPref): void {
  try {
    localStorage.setItem(PAPER_KEY, JSON.stringify(p));
  } catch {
    /* 存不下就这次生效、下次回跟随系统 */
  }
}

/**
 * 最终用不用深色纸。**判据只有这一处**——layout 要它、main.tsx 首帧也要它，
 * 两边各写一遍的话，刷新时会先按一套画、再跳到另一套。
 */
export function isDarkPaper(pref: PaperPref, systemDark: boolean): boolean {
  return pref === 'system' ? systemDark : pref === 'dark';
}
