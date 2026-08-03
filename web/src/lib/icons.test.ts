import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * 那四个图标，跟声明它们的地方对得上。
 *
 * ── 为什么需要它 ──
 *
 * `web/public/*.png` **是四个静态文件，没有生成脚本**。曾经有一个（跑 Python + Pillow
 * 画字形），三轮审查下来一直在冒新问题，删掉了——理由记在 web/index.html 的注释里。
 * 那个脚本在的时候，"图标画错了"至少还有生成时的检查兜一下；现在没有了，
 * 这个文件是唯一还盯着它们的东西。
 *
 * 而这个仓库里其他每一处派生值都有人盯着——STOP_HINT 跟 index.ts 对账、
 * worthANote 只有一处实现、启动器的 CRLF/ASCII、笔记 trigger 跟 extractTags。
 * 图标不该是唯一的例外。
 *
 * ── 守什么、不守什么 ──
 *
 * **不守字节**：png 的压缩流跟编码器版本走，拿哈希当判据等于换个工具就红一次。
 * 守的是**解出来的像素**和**跨文件的一致性**：尺寸、有没有真的画上东西、
 * 底色跟 manifest / index.html / theme.ts 说的是不是同一个。
 *
 * 判据换过两轮，两次都是因为**量错了东西**：
 *
 *   「字节数 > 1500」  纯色 512 RGBA 实测正好 2202 字节 —— 两张 512 一张都拦不住，
 *                     而那正是最要紧的两张。
 *   「不同颜色 > 40」  那是在量抗锯齿的丰富度：同一个图形，512 解出 31 种颜色、
 *                     maskable 解出 660 种，差别全来自渲染器和缩放。
 *
 * 现在量的是**墨覆盖率**——多少像素不是纸色。空白图恒等于 0，换个画法也不会误红。
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const PUB = join(ROOT, 'web', 'public');

interface Png { w: number; h: number; px: Buffer; ch: number }

/**
 * 解一张 8 位 RGBA / RGB 的非隔行 png。够用就行，不做成通用解码器。
 * 只认这几种是有意的：不是这几种就说明图标的产出方式变了，那时该有人来看一眼。
 */
function decodePng(buf: Buffer): Png {
  expect(buf.subarray(0, 8).toString('latin1'), '不是 png').toBe('\x89PNG\r\n\x1a\n');
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat: Buffer[] = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('ascii');
    if (type === 'IHDR') {
      w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12);
      bd = buf[p + 16]; ct = buf[p + 17];
      expect(buf[p + 20], '隔行 png，这个解码器不认').toBe(0);
    }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  expect(bd, '不是 8 位色深').toBe(8);
  expect([2, 6], `色彩类型 ${ct} 不认（只处理 RGB / RGBA）`).toContain(ct);
  const ch = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  // 逐行反滤波（png 规范第 9 节）。上一行/左一像素越界时按 0 算。
  for (let y = 0, q = 0; y < h; y += 1) {
    const f = raw[q]; q += 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = raw[q + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
    q += stride;
  }
  return { w, h, px: out, ch };
}

const hex = (png: Png, i: number) =>
  `#${[0, 1, 2].map((k) => png.px[i + k].toString(16).padStart(2, '0')).join('')}`;

/**
 * 量两件事：有多少像素**不是纸色**（有没有画上东西），其中多少**偏蓝**（第二版在不在）。
 * 为什么不是数颜色种类，见文件头那段「判据换过两轮」。
 */
function coverage(png: Png): { ink: number; blue: number } {
  let ink = 0, blue = 0, total = 0;
  for (let i = 0; i < png.px.length; i += png.ch) {
    const r = png.px[i], g = png.px[i + 1], b = png.px[i + 2];
    total += 1;
    if (Math.abs(r - 0xfa) + Math.abs(g - 0xf9) + Math.abs(b - 0xf5) <= 30) continue;
    ink += 1;
    if (b - r > 40 && b > 90) blue += 1;      // 蓝明显压过红，且不是近黑（叠印过的地方是黑）
  }
  return { ink: ink / total, blue: blue / total };
}

const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'favicon.png'];
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(PUB, 'manifest.webmanifest'), 'utf8')) as {
  icons: Array<{ src: string; sizes: string }>;
  background_color: string;
  theme_color: string;
};

describe('图标：文件、尺寸、内容', () => {
  it('前提：manifest 真的声明了图标', () => {
    expect(manifest.icons.length, '一个都没声明，这条守卫是空的').toBeGreaterThanOrEqual(2);
  });

  it.each(manifest.icons.map((i) => [i.src, i.sizes] as const))(
    'manifest 声明的 %s 存在，而且真是 %s',
    (src, sizes) => {
      const file = join(PUB, src.replace(/^\//, ''));
      expect(existsSync(file), `manifest 指着 ${src}，但文件不在`).toBe(true);
      const png = decodePng(readFileSync(file));
      expect(`${png.w}x${png.h}`, `${src} 实际是 ${png.w}x${png.h}`).toBe(sizes);
    },
  );

  it('favicon 也在，而且是 32×32', () => {
    const png = decodePng(readFileSync(join(PUB, 'favicon.png')));
    expect([png.w, png.h]).toEqual([32, 32]);
  });

  // 门槛取 2%。当前四张实测在 11%～22% 之间（maskable 最低，它本来就画得小），
  // 隔着五倍以上——「字画到画布外了」「前景色被改成跟纸一样」「scale 设成 0」
  // 这一类全拦得住，而重画一版、换个字号都不会误红。
  //
  // **别在注释里钉死具体那四个数**：这里原先写着「9.4 / 8.9 / 5.6 / 8.9」，
  // 重画一版之后全都翻了倍，而没有任何东西会因此变红。门槛是判据，那几个数只是
  // 当时的量值——写一个区间，重画之后仍然成立；写四个小数，下次就是一句假话。
  it.each(ICONS)('%s 上真的画了东西', (name) => {
    const { ink } = coverage(decodePng(readFileSync(join(PUB, name))));
    expect(ink, `${name} 只有 ${(ink * 100).toFixed(1)}% 的像素不是纸色，像是空白`)
      .toBeGreaterThan(0.02);
  });

  /**
   * 第二版（蓝）是这个标记的**全部意思**：黑版是标准音，蓝版是你发的音，
   * 错开就是念错了。蓝版要是悄悄没画上，图标退化成一个普通的 ə，
   * 而它看起来仍然"正常"——没人会发现。
   */
  it.each(ICONS.filter((n) => n !== 'favicon.png'))('%s 有第二版油墨', (name) => {
    const { blue } = coverage(decodePng(readFileSync(join(PUB, name))));
    expect(blue, `${name} 几乎没有蓝色像素，第二版没印上`).toBeGreaterThan(0.01);
  });

  /**
   * maskable 那张会被系统**裁成圆**（Android 的自适应图标），安全区是中间 80%。
   * 画大了就会被切掉边——而这件事只有真装到手机上才看得见，本机怎么看都是好的。
   * 所以这里直接量：安全圆之外不许有一个墨像素。
   */
  it('maskable 的图案全在安全区内——它会被裁成圆', () => {
    const png = decodePng(readFileSync(join(PUB, 'icon-maskable-512.png')));
    const r = png.w * 0.4, cx = png.w / 2, cy = png.h / 2;
    let outside = 0;
    for (let y = 0; y < png.h; y += 1) {
      for (let x = 0; x < png.w; x += 1) {
        const i = (y * png.w + x) * png.ch;
        const dr = Math.abs(png.px[i] - 0xfa) + Math.abs(png.px[i + 1] - 0xf9)
          + Math.abs(png.px[i + 2] - 0xf5);
        if (dr <= 30) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) outside += 1;
      }
    }
    expect(outside, `安全圆外还有 ${outside} 个墨像素，装到手机上会被切掉`).toBe(0);
  });

  /**
   * **favicon 反过来：不许有第二版。** 32px 上那点错位只剩噪音，
   * 缩到标签页尺寸两版糊成一团，反而认不出是什么字。所以它单画一版黑的。
   * 这条断言把那个决定写成可执行的——哪天有人图省事把大图缩成 favicon，它会红。
   */
  it('favicon 是单版——32px 上错位只剩噪音', () => {
    const { blue } = coverage(decodePng(readFileSync(join(PUB, 'favicon.png'))));
    expect(blue, 'favicon 上出现了蓝版，多半是拿大图缩下来的').toBe(0);
  });
});

describe('底色：四处声明的是同一个', () => {
  /**
   * `#faf9f5` 在四个地方各写了一份，而且没有共同的来源：
   * manifest 的 background_color 和 theme_color、index.html 的 meta theme-color、
   * theme.ts 的 LIGHT_BASE.paper，加上图标自己画上去的那一片。
   *
   * 改一处忘了别处，装成应用之后的表现是：启动闪屏和状态栏还是旧色，
   * 图标是新色——冷启动时图标周围一圈明显的接缝。而这种事本机看不出来，
   * 要真把它装成 PWA 才现形。
   */
  const paper = manifest.background_color;

  it('manifest 自己的两个字段一致', () => {
    expect(manifest.theme_color, 'background_color 和 theme_color 不一样').toBe(paper);
  });

  it('index.html 的 meta theme-color 跟它一致', () => {
    const m = /<meta\s+name="theme-color"\s+content="([^"]+)"/.exec(html);
    expect(m, 'index.html 里没有 meta theme-color').not.toBeNull();
    expect(m![1].toLowerCase()).toBe(paper.toLowerCase());
  });

  it('theme.ts 的浅色纸跟它一致', () => {
    const src = readFileSync(join(ROOT, 'web', 'src', 'theme.ts'), 'utf8');
    const m = /paper:\s*'(#[0-9a-fA-F]{6})'/.exec(src);
    expect(m, 'theme.ts 里找不到 paper').not.toBeNull();
    expect(m![1].toLowerCase()).toBe(paper.toLowerCase());
  });

  it('图标画上去的底色也是它——这条把二进制和声明绑在一起', () => {
    for (const name of ICONS) {
      const png = decodePng(readFileSync(join(PUB, name)));
      expect(hex(png, 0).toLowerCase(), `${name} 左上角不是 ${paper}`).toBe(paper.toLowerCase());
    }
  });
});

describe('index.html 引到的静态文件都在', () => {
  /**
   * **不能只断言"匹配到的都在"**：那样一条正则漏掉的引用会安安静静地掉出集合，
   * 而 `refs.length > 0` 靠 manifest 那一条就永远成立。原来的版本正是这样——
   * favicon 那行被删掉、改成相对路径、或者挪进子目录，测试照绿。
   * 所以这里点名要求这两条必须在。
   */
  const refs = [...html.matchAll(/(?:href|src)=["']\/?([\w./-]+\.(?:png|webmanifest|ico|svg))["']/g)]
    .map((m) => m[1]);

  it('点名要求：favicon 和 manifest 的引用都还在', () => {
    expect(refs, 'index.html 不再引 favicon.png 了').toContain('favicon.png');
    expect(refs, 'index.html 不再引 manifest.webmanifest 了').toContain('manifest.webmanifest');
  });

  it.each(refs.length ? refs : ['（没扫到引用）'])('%s 在 web/public 里真的有', (r) => {
    expect(existsSync(join(PUB, r)), `index.html 引了 ${r}，但 web/public 里没有`).toBe(true);
  });
});
