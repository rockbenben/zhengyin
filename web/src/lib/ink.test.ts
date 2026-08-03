import { describe, it, expect } from 'vitest';
import { DEFAULT_HUE, PRESETS, inkFor, normalizeHue } from './ink';
import { paletteFor } from '../theme';

/**
 * 换墨这件事的**唯一风险是换到看不清**。这个仓库为对比度栽过一次：设置页三个标签
 * 在深色下 1.22:1，等于没显示——而那还只是一处硬编码的颜色，现在是让人随便转色相。
 *
 * 界面上只给备好的那几款墨（没有自由取色器，理由见 ink.ts 的 PRESETS），
 * 所以这里量的就是**要发出去的那几款**：每款 × 2 套纸 × 3 组真实配对，
 * 一个都不许低于 4.5:1。加新墨的人不用记得来改测试——它自己遍历 PRESETS。
 *
 * 三组配对不是凭空列的，是界面上真的这么叠的：
 *   墨压纸        音素格、链接、焦点框（PhonemeBar、styles.css 的 :focus-visible）
 *   墨压淡网点    命中的音素格（蓝字压蓝底）、Segmented 选中项（theme.ts）
 *   黑版压淡网点  表格悬停行（Table.rowHoverBg = blueSoft，行内是正文黑字）
 *
 * 存取那几条不在这里：这个文件跑在 node 档（vitest.config.ts 把 web/src/lib 归到那边），
 * 没有 localStorage。它们跟换墨的界面一起测，见 components/InkSetting.test.tsx。
 */

function luminance(hex: string): number {
  const m = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const s = parseInt(m.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const HUES = PRESETS.map((p) => p.hue);

describe.each([['浅色', false], ['深色', true]] as Array<[string, boolean]>)(
  '%s纸：任何色相都得看得清',
  (_label, dark) => {
    // 配对里的纸和黑版取自真实调色板，不是另抄一份常量——抄一份就会漂移
    const base = paletteFor(dark, DEFAULT_HUE);

    it('墨压纸、墨压网点、黑版压网点，每一款墨都 ≥ 4.5:1', () => {
      let worst = { ratio: Infinity, msg: '' };
      for (const h of HUES) {
        const { ink, soft } = inkFor(h, dark);
        const pairs: Array<[string, string, string]> = [
          ['墨压纸', ink, base.paper],
          ['墨压网点', ink, soft],
          ['黑版压网点', base.black, soft],
        ];
        for (const [name, fg, bg] of pairs) {
          const r = contrast(fg, bg);
          const ink = PRESETS.find((x) => x.hue === h)!.name;
          if (r < worst.ratio) worst = { ratio: r, msg: `${ink}：${name} ${fg} 压 ${bg}` };
        }
      }
      expect(worst.ratio, `最差的一处 —— ${worst.msg} = ${worst.ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
    });

    it('每款墨的分量要一样——这是"加一款墨不用重新调"的前提', () => {
      // 亮度钉死是整套设计的地基：固定感知亮度，换哪一款都在同一条可读性水平线上，
      // 所以加新墨只需要给一个色相，不用再人肉验一遍对比度。
      //
      // 这条同时钉住**超色域时降彩度、不砍通道**那一步（7 款里有 5 款超色域）。
      // 砍通道等于连亮度一起改：浅色纸上实测 spread 从 1.27 涨到 1.58，
      // 每款墨看起来轻重不一，而"亮度不变"这个前提也就没了。
      // 阈值 1.35 卡在两者之间：现在是 1.27，还有余量；退回砍通道立刻红。
      const lums = HUES.map((h) => luminance(inkFor(h, dark).ink));
      const spread = Math.max(...lums) / Math.min(...lums);
      expect(spread, `最重和最轻的墨差了 ${spread.toFixed(3)} 倍`).toBeLessThan(1.35);
    });
  },
);

describe('默认色相就是原来那版群青', () => {
  it('浅色纸上算出来的墨跟手调的 #1b3fa8 几乎一样', () => {
    // 不要求逐字节相等：L/C 是从那个 hex 量出来的，往返有舍入。
    // 要求的是**看不出差别**——每个通道差不超过 4/255。
    const got = inkFor(DEFAULT_HUE, false).ink;
    expect(near(got, '#1b3fa8'), `算出来是 ${got}`).toBe(true);
  });

  it('深色纸上跟手调的 #8aa5ea 几乎一样', () => {
    const got = inkFor(DEFAULT_HUE, true).ink;
    expect(near(got, '#8aa5ea'), `算出来是 ${got}`).toBe(true);
  });
});

function near(a: string, b: string): boolean {
  const ch = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
  return ch(a).every((v, i) => Math.abs(v - ch(b)[i]) <= 4);
}

describe('色相的边界处理', () => {
  it('负数和超过 360 的都绕回来', () => {
    expect(normalizeHue(-1)).toBe(359);
    expect(normalizeHue(720)).toBe(0);
    expect(normalizeHue(365)).toBe(5);
  });

  it('坏值一律回默认，不让它传下去', () => {
    // null 这一条是真踩过的：`Number(null)` 是 0，而 0 是合法色相（红），
    // 于是一个坏值会静悄悄变成一版红墨，还看不出是哪儿来的。
    for (const bad of [NaN, undefined, null, 'abc', {}, '266']) {
      expect(normalizeHue(bad), String(bad)).toBe(DEFAULT_HUE);
    }
  });

  it('0 和 359 首尾相接，不该有断层', () => {
    expect(near(inkFor(0, false).ink, inkFor(359.9, false).ink)).toBe(true);
  });
});

describe('预置油墨', () => {
  it('每一款都能算出颜色，而且互不相同——重复的预置等于占位', () => {
    const inks = PRESETS.map((p) => inkFor(p.hue, false).ink);
    expect(new Set(inks).size).toBe(PRESETS.length);
  });

  it('第一款就是默认那版群青——点它等于回到出厂', () => {
    expect(PRESETS[0].hue).toBe(DEFAULT_HUE);
  });
});

/**
 * ── 墨屉的两条硬规矩 ──
 *
 * 这两条都是**实测打出来的**，不是先验的审美偏好。
 *
 * 凭肉眼在浅色纸上挑出来的七款里，赭石 / 洋红 / 橄榄三款在**深色纸上**
 * 分别贴着琥珀（提醒）和红（清除）：ΔE 0.045 / 0.070 / 0.078，而 0.045 就是
 * "看不出区别"的量级。浏览器里并排一看，「有笔记」和「提醒」两个标签确实分不开。
 * 肉眼只在一套纸上看过，就会漏掉另一套——所以改成量。
 *
 * 距离用 OKLab 里的欧氏距离（感知均匀，比 RGB 距离靠谱得多）。
 * **这里自己实现一遍转换**，不从 ink.ts 引：那边算错了的话，共用一份实现就同时错、
 * 测不出来。theme.test.tsx 的 luminance 也是同一个道理，照它的先例。
 */

function oklab(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m2 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m2 - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m2 + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m2 - 0.8086757660 * s,
  ];
}

const deltaE = (a: string, b: string): number => {
  const [x, y, z] = oklab(a);
  const [p, q, r] = oklab(b);
  return Math.hypot(x - p, y - q, z - r);
};

describe('墨屉的两条硬规矩', () => {
  const PAPERS = [false, true];

  it('每一款墨都离「提醒」和「清除」足够远——撞上了信号就废了', () => {
    // 0.12 卡在两簇中间：留下的四款是 0.148–0.198，删掉的三款是 0.045–0.078。
    let worst = { d: Infinity, msg: '' };
    for (const dark of PAPERS) {
      const p = paletteFor(dark, DEFAULT_HUE);
      for (const preset of PRESETS) {
        const { ink } = inkFor(preset.hue, dark);
        for (const [name, sem] of [['提醒', p.amber], ['清除', p.red]] as const) {
          const d = deltaE(ink, sem);
          if (d < worst.d) {
            worst = { d, msg: `${preset.name} 在${dark ? '深' : '浅'}色纸上离「${name}」只有` };
          }
        }
      }
    }
    expect(worst.d, `${worst.msg} ${worst.d.toFixed(3)}`).toBeGreaterThanOrEqual(0.12);
  });

  it('两款墨之间也要分得开——长得一样的两款等于只有一款', () => {
    // 0.06 的参照物就是被删掉的赭石：它离琥珀 0.045，实测"看不出区别"。
    let worst = { d: Infinity, msg: '' };
    for (const dark of PAPERS) {
      for (let i = 0; i < PRESETS.length; i++) {
        for (let j = i + 1; j < PRESETS.length; j++) {
          const d = deltaE(inkFor(PRESETS[i].hue, dark).ink, inkFor(PRESETS[j].hue, dark).ink);
          if (d < worst.d) {
            worst = { d, msg: `${PRESETS[i].name} 和 ${PRESETS[j].name} 在${dark ? '深' : '浅'}色纸上只差` };
          }
        }
      }
    }
    expect(worst.d, `${worst.msg} ${worst.d.toFixed(3)}`).toBeGreaterThanOrEqual(0.06);
  });
});
