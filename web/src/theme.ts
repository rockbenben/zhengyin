import type { ThemeConfig } from 'antd';
import { inkFor, DEFAULT_HUE } from './lib/ink';

/**
 * 套印（Overprint）—— 这个工具的视觉系统。
 *
 * 核心隐喻：诊断是一次双色凸版印刷的套准。标准音印黑版，你发的音印蓝版；
 * 发对了两版完全重合读作一个字，发错了蓝版滑开、你直接看见重影。
 * 四种诊断结果全部从这一个隐喻里长出来，不需要额外发明符号：
 *   对   两版套准，只见一个黑字
 *   错   黑蓝错位，肉眼可见重影
 *   漏   只有黑版，底下是空槽
 *   多   一个没有黑底的孤立蓝字
 *
 * 刻意**不用红色报错**。CLAUDE.md 写着要"打消他的顾虑，绝大多数是方言习惯不是生理
 * 缺陷"——"套没套准"是工艺判断，"对/错"是评判，二者给人的感受完全不同。红色只留给
 * 真正的破坏性操作（清除 key、删词条）。
 *
 * 深色版不是把浅色反相，而是同一套工艺的另一种纸：**深色纸上印白墨**。
 * 黑版变成骨白，蓝版提亮以便在深底上立得住，套印逻辑一个字不改。
 *
 * 第二版油墨的**颜色可以换**（设置页），但只让色相转、亮度彩度钉死——
 * 于是换到哪个色相都还看得清。那套算法在 lib/ink.ts，理由也写在那儿。
 *
 * antd 只当底座：交互逻辑与可达性用它的组件，视觉全部走这里的 token 与
 * styles.css 的 CSS variables，避免开箱即用的 antd 观感。
 */

export interface Palette {
  paper: string;      // 纸
  paperDeep: string;  // 深一档的纸：侧栏、表头
  black: string;      // 黑版：标准音
  blue: string;       // 蓝版：你发的音
  blueSoft: string;   // 蓝版的淡网点：底纹、悬停
  slot: string;       // 空槽的虚线。只用于线，不用于文字（对比度不够读）
  rule: string;       // 版面线
  quiet: string;      // 弱文字
  amber: string;      // 提醒（模型拿不准、待办）
  red: string;        // 只给破坏性操作
}

/**
 * 除蓝版之外的部分。**蓝版不在这里**——它由 lib/ink.ts 按色相算出来，
 * 这样"换一版油墨"只有一处判据，不会出现常量和算法各说各的。
 */
const LIGHT_BASE = {
  paper: '#faf9f5',
  paperDeep: '#f1efe7',
  black: '#17161b',
  slot: '#b9b4a8',
  rule: '#dedace',
  quiet: '#514c43',
  amber: '#8a5d0d',
  red: '#a3372c',
} as const;

/** 深色纸 + 白墨。不是反相：暖炭底、骨白墨，套印逻辑不变 */
const DARK_BASE = {
  paper: '#1a1917',
  paperDeep: '#131211',
  black: '#eae7dd',
  slot: '#4b473f',
  rule: '#302d28',
  quiet: '#9a948a',
  amber: '#d3a44e',
  red: '#e08b7f',
} as const;

/**
 * 某个色相在某套纸上的完整调色板。
 *
 * **能换的只有蓝版**（"你发的音"那一版）。黑版是标准音、红只给破坏性操作、
 * 琥珀是提醒——那三个是语义，换了会说错话，所以不跟着色相走。
 * 色相怎么保证换到哪儿都还看得清，见 lib/ink.ts 开头。
 */
export function paletteFor(dark: boolean, hue: number = DEFAULT_HUE): Palette {
  const { ink, soft } = inkFor(hue, dark);
  return { ...(dark ? DARK_BASE : LIGHT_BASE), blue: ink, blueSoft: soft };
}

export const LIGHT: Palette = paletteFor(false);
export const DARK: Palette = paletteFor(true);

/**
 * 字体：全部走系统栈。这不是妥协——这个工具只跑在这一台机器上，系统字体渲染完全可控，
 * 而且 Segoe UI / Cambria 的 IPA 字符覆盖是最稳的（ɪ ɛ æ ɑ ɔ ʊ ʌ ə ɚ ɝ ŋ ʃ ʒ θ ð
 * tʃ dʒ ɡ ɹ ɾ 全都有）。换 Web 字体反而要赌 IPA 覆盖，还得处理加载抖动。
 */
const FONT = {
  body: '"Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif',
  /**
   * 词条大字。Cambria 的字重与字怀撑得住 64px 以上。
   * 中文回落到宋体是**有意的**，不是凑合：宋体本来就是中文的印刷体（名字直接来自
   * 宋代雕版），跟这套视觉的凸版隐喻是同一件事。两种文字用各自的印刷体，配得上。
   */
  display: 'Cambria, "Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, Georgia, serif',
  /**
   * IPA 专用。**不打包字体**，这一条是量过的。
   *
   * 口径写清楚，好让人重新量：**界面会显示的** 43 个 IPA / 变音字符 ——
   * articulation.ts 那 41 个音素的符号，加 `ˈ ˌ ː`，加笔记正文里出现的 `ɫ ɾ ʰ`。
   * （服务端 espeak.ts 那张映射表里还有 `ɹ ɜ ʉ ɐ ɒ ᵻ ɯᵝ` 一批，那些只用于把模型输出
   * 归一到本项目的音素表，从不渲染，所以不算在内。）
   *
   * 读 cmap 实测：Segoe UI（Windows）、Lucida Sans Unicode、Arial **三个一个不缺**。
   * DejaVu Sans（Linux 常见）以 Unicode 覆盖面广著称，但不在这台机器上，没复核。
   * 所以不是"只有 Segoe UI 行"，而是主流桌面上随便哪个兜底字体都够用，
   * 为它打包几十上百 KB 不划算。
   *
   * 排在最前只是**挑一个好看的**：Segoe UI 的音标字形更周正。
   *
   * 另外 Chrome 是**逐字符回退**的：某个字形当前字体没有，它会去系统里再找一个，
   * 不会直接画豆腐块。所以 --font-body 首选的 Microsoft YaHei 按同一口径缺 16 个
   * 这件事也不成问题（读 cmap 实测，确实缺；界面上照样显示正常）。
   */
  ipa: '"Segoe UI", "Lucida Sans Unicode", sans-serif',
  /** 数据与小标签：等宽 */
  mono: 'Consolas, "Cascadia Mono", monospace',
} as const;

/** 把调色板写成 CSS variables，供 styles.css 使用——保证 antd 与手写样式同源，不会漂移 */
export function applyPalette(p: Palette): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(p)) {
    root.style.setProperty(`--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, v);
  }
  root.style.setProperty('--font-body', FONT.body);
  root.style.setProperty('--font-display', FONT.display);
  root.style.setProperty('--font-ipa', FONT.ipa);
  root.style.setProperty('--font-mono', FONT.mono);
}

export function makeTheme(p: Palette): ThemeConfig {
  return {
    token: {
      colorPrimary: p.blue,
      colorInfo: p.blue,
      // "对"不用绿色：套准了就是一个正常的黑字，不该额外庆祝
      colorSuccess: p.black,
      colorWarning: p.amber,
      colorError: p.red,

      colorBgBase: p.paper,
      colorBgContainer: p.paper,
      colorBgLayout: p.paperDeep,
      colorBgElevated: p.paper,

      colorTextBase: p.black,
      colorBorder: p.rule,
      colorBorderSecondary: p.rule,

      /**
       * 弱文字用调色板自己的 `quiet`，**不要让 antd 从 colorTextBase 派生**。
       *
       * antd 派生出来的是 45% 透明度的黑，压在纸上实测**只有 2.91:1**（AA 要 4.5）。
       * 而全站有四十多处 `type="secondary"`——所有"这一块是干什么的""为什么这么排"
       * 的说明文字都是那一档，等于整套解释性文案都不达标。
       *
       * 调色板本来就备着 quiet（浅 #514c43 / 深 #9a948a，两套都在 5.8 以上），
       * 菜单、表头、空状态早就在用它，只有 Typography 漏了。
       */
      colorTextSecondary: p.quiet,
      colorTextTertiary: p.quiet,
      colorTextDescription: p.quiet,

      fontFamily: FONT.body,
      fontFamilyCode: FONT.mono,
      fontSize: 14,

      // 凸版印刷没有圆角
      borderRadius: 2,
      borderRadiusLG: 2,
      borderRadiusSM: 2,
      borderRadiusXS: 1,

      // 纸面上没有投影。用线，不用阴影
      boxShadow: 'none',
      boxShadowSecondary: 'none',
      boxShadowTertiary: 'none',

      wireframe: false,
      lineWidth: 1,
      controlHeight: 34,
    },
    components: {
      Layout: { siderBg: p.paperDeep, bodyBg: p.paper, headerBg: p.paper },
      Menu: {
        itemBg: 'transparent', itemSelectedBg: 'transparent',
        itemSelectedColor: p.blue, itemColor: p.quiet,
        itemHoverColor: p.black, itemHoverBg: 'transparent',
        itemHeight: 34, itemMarginInline: 0, itemBorderRadius: 0, activeBarWidth: 0,
      },
      Card: { headerBg: 'transparent', headerFontSize: 13, paddingLG: 22 },
      /**
       * `primaryColor` = 主按钮上那行字的颜色。**必须跟着纸走，不能用 antd 的默认白。**
       *
       * 第二版油墨是为「印在纸上当字」调的：深色纸上它是浅蓝（#8aa5ea），
       * 当字印在纸上有 7.27:1。可主按钮把关系倒过来了——它拿这版蓝**当底**，
       * antd 默认再压一行白字上去，实测**只有 2.42:1**（AA 要 4.5）。
       * 浅色纸没事（深蓝底白字 9.08:1），所以肉眼只在浅色下看过就会漏掉。
       *
       * 用纸色当字色，深浅两套都回到 7 以上——这跟墨屉那条规矩同源：
       * 亮度关系一旦反转就得重新量，不能假设换个背景还成立。
       * theme.test.tsx 盯着这条。
       */
      Button: {
        fontWeight: 500,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        primaryColor: p.paper,
      },
      Table: {
        headerBg: p.paperDeep, headerColor: p.quiet, borderColor: p.rule,
        rowHoverBg: p.blueSoft, cellPaddingBlockSM: 9,
      },
      Alert: {
        defaultPadding: '13px 16px',
        // 底色一律用纸色，只留一条彩色边框。
        // antd 默认会从 colorInfo / colorWarning 派生一个浅色底，而这一版的 colorInfo
        // 是深群青、colorLink 也来自它——蓝字压蓝底，对比度直接垮掉（"这几个音还没有
        // 笔记"那条就是这么变得看不清的）。放在纸上就永远不会因为配色微调而失守。
        colorInfoBg: p.paper, colorInfoBorder: p.blue,
        colorWarningBg: p.paper, colorWarningBorder: p.amber,
        colorErrorBg: p.paper, colorErrorBorder: p.red,
        colorSuccessBg: p.paper, colorSuccessBorder: p.black,
      },
      Tag: {
        defaultBg: 'transparent', defaultColor: p.quiet,
        // ── 带语义色的 Tag 走跟 Alert 完全一样的路：纸底 + 一条彩边 ──
        //
        // 上面 Alert 那段注释讲的问题，Tag 一个字不差地又犯了一遍，而且更狠：
        // antd 会从语义色**派生一个浅色底**。深色主题下 colorSuccess 是 p.black
        // ——而深色调色板里的 black 是浅墨 #eae7dd，"提亮"之后就成了近白 #fffef0，
        // 文字却还是 #eae7dd。实测对比度 **1.22:1**，比 slot 那个 1.96:1 还低，
        // 「已配置 ••••847f」「已下载」这几个标签基本等于没显示。
        // （浅色主题下 p.black 是深色，派生出来的浅底反倒正常——所以这个 bug
        //   只在深色下出现，用浅色主题的人一辈子撞不上。）
        //
        // 四个语义色全设上，不只补出问题的那一个：下一个 <Tag color="error"> 会
        // 一模一样地垮掉，而那时候又得从头查一遍。
        colorSuccessBg: p.paper, colorSuccessBorder: p.black, colorSuccessText: p.black,
        colorInfoBg: p.paper, colorInfoBorder: p.blue, colorInfoText: p.blue,
        colorWarningBg: p.paper, colorWarningBorder: p.amber, colorWarningText: p.amber,
        colorErrorBg: p.paper, colorErrorBorder: p.red, colorErrorText: p.red,
      },
      Progress: { defaultColor: p.blue, remainingColor: p.rule },
      Input: { activeShadow: 'none' },
      Collapse: { headerBg: 'transparent', contentPadding: '14px 0 4px' },
      Tooltip: { colorBgSpotlight: p.black, colorTextLightSolid: p.paper },
      Empty: { colorTextDescription: p.quiet },
      Segmented: { itemSelectedBg: p.blueSoft, itemSelectedColor: p.blue, trackBg: 'transparent' },
    },
  };
}
