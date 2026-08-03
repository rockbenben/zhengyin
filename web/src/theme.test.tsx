import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIGHT, DARK, makeTheme, type Palette } from './theme';

/**
 * 语义色控件的**可读性**。
 *
 * 起因是一个真实撞上的 bug：设置页的「已配置 ••••847f」「已下载」三个标签在深色主题下
 * 是浅色底 + 浅色字，实测对比度 **1.22:1**，基本等于没显示。
 *
 * 机制：antd 会从语义色**派生一个浅色底**。深色调色板里 colorSuccess 取的是 p.black
 * ——而深色下的 black 是浅墨 #eae7dd，"提亮"之后成了近白 #fffef0，文字却还是 #eae7dd。
 * 浅色主题下 p.black 是深色，派生出来的浅底反倒正常，所以这个 bug **只在深色下出现**，
 * 用浅色主题的人一辈子撞不上。
 *
 * 同一个坑 Alert 那边早就填过（theme.ts 里那段注释讲的就是它），只是没推广到 Tag。
 * 所以这里守的不是那三个标签，是**规则**：凡是给 antd 语义色的地方，
 * 底色和文字色都得自己定死，且四个语义色 × 两套调色板一个都不低于 4.5:1。
 *
 * 断言落在 token 上而不是渲染结果上，是因为 antd v6 用 CSS 变量出色值
 * （`var(--ant-color-success)`），jsdom 不解析它——读到的永远是那串变量名，
 * 算出来对比度恒等于 1，测什么都"失败"。而 bug 本来就在 token 里。
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

const SEMANTIC = ['Success', 'Info', 'Warning', 'Error'] as const;

// 会从语义色派生浅色底的控件。Alert 早就填过，Tag 是这次补的。
// 再有新的控件用到语义色，加进这张表——它会立刻告诉你有没有踩同一个坑。
const COMPONENTS = ['Alert', 'Tag'] as const;

describe.each([['浅色', LIGHT], ['深色', DARK]] as Array<[string, Palette]>)(
  '%s主题',
  (_theme, p) => {
    const components = makeTheme(p).components as Record<string, Record<string, string>>;

    describe.each(COMPONENTS)('%s', (name) => {
      const tokens = components[name];

      it.each(SEMANTIC)('color%s 的底色必须自己定死，不能让 antd 去派生', (s) => {
        expect(tokens[`color${s}Bg`], `${name} 没给 color${s}Bg`).toBeTruthy();
      });

      it.each(SEMANTIC)('color%s 的文字压在底色上不低于 4.5:1', (s) => {
        const bg = tokens[`color${s}Bg`];
        // Alert 的文字色走全局 colorTextBase（纸上印墨），Tag 这边自己指定
        const fg = tokens[`color${s}Text`] ?? p.black;
        const r = contrast(fg, bg);
        expect(r, `${name} color${s}：${fg} 压 ${bg} 只有 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    });
  },
);

/**
 * ── 红色只给破坏性操作，不给"你念错了" ──
 *
 * theme.ts 开头白纸黑字：「刻意**不用红色报错**……"套没套准"是工艺判断，
 * "对/错"是评判，二者给人的感受完全不同。红色只留给真正的破坏性操作」。
 * 而实测扫下来，有三处在拿红色给**发音判决**上色：笔记的「反复出现」标签、
 * 降级路径里「念成了对立词」的 Tag、以及那条「第 N 个音发成了对立音」的 Alert。
 *
 * 单点断言拦不住下一处，所以这条按**规则**写：扫源码，红色的出现位置必须在白名单上，
 * 而白名单里只有三类——破坏性操作、系统故障、正在录音的实时状态。
 * 加一处新的红，要么它属于这三类（把它加进白名单，顺便说清理由），
 * 要么就是踩了这条规矩。
 */
/** 按行拆源码 */
const SPLIT_LINES = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));

/**
 * 把注释剥掉再扫颜色。
 * 注释里出现 error / danger 通常正是在解释**为什么不用**它们——
 * 把那些算成"用了红"，这条规则就永远是红的，然后会被人 skip 掉。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释，含 JSX 里的 {/* … */}
    .replace(/^\s*\/\/.*$/gm, '');      // 行注释
}

/**
 * 主按钮上那行字。
 *
 * 第二版油墨是为「印在纸上当字」调的：深色纸上它是浅蓝，当字有 7.27:1。
 * 而主按钮把关系倒过来——拿这版蓝**当底**。用 antd 默认的白字实测只有 **2.42:1**，
 * 而浅色纸那边（深蓝底白字）有 9，所以只在浅色下看过就会整个漏掉。
 *
 * 用纸色当字色，两套纸都回到 7 以上。
 */
describe.each([['浅色', LIGHT], ['深色', DARK]] as Array<[string, Palette]>)(
  '%s主题的主按钮',
  (_theme, p) => {
    it('按钮上的字压在按钮底色上不低于 4.5:1', () => {
      const btn = (makeTheme(p).components as Record<string, Record<string, string>>).Button;
      expect(btn?.primaryColor, '没指定 primaryColor，antd 会默认用白字').toBeTruthy();
      const r = contrast(btn.primaryColor, p.blue);
      expect(r, `${btn.primaryColor} 压在 ${p.blue} 上只有 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  },
);

/**
 * 弱文字（`type="secondary"`，全站四十多处说明性文案用的那一档）。
 *
 * **不能让 antd 从 colorTextBase 派生。** 它给的是 45% 透明度的黑，压在纸上
 * 实测只有 2.91:1——所有"这一块是干什么的""为什么这么排"的解释文字全都不达标。
 * 调色板本来就备着 quiet，菜单/表头/空状态早就在用，只有 Typography 漏了。
 */
describe.each([['浅色', LIGHT], ['深色', DARK]] as Array<[string, Palette]>)(
  '%s主题的弱文字',
  (_theme, p) => {
    it.each(['colorTextSecondary', 'colorTextTertiary', 'colorTextDescription'])(
      '%s 必须自己定死，不能让 antd 派生',
      (name) => {
        const token = (makeTheme(p).token as Record<string, string>)[name];
        expect(token, `没给 ${name}，antd 会派生出 45% 透明度的黑`).toBeTruthy();
        const r = contrast(token, p.paper);
        expect(r, `${token} 压在纸上只有 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      },
    );
  },
);

/**
 * 键盘焦点环。
 *
 * 只用鼠标的人永远看不到它，所以它最容易在某次改版里被顺手删掉，
 * 而删了之后用键盘的人就完全不知道自己走到哪儿了。
 *
 * 断言落在样式表源码上：焦点环是 `:focus-visible` 的伪类规则，
 * jsdom 不跑真实键盘导航，渲染出来验不了。
 */
describe('键盘焦点环', () => {
  const css = readFileSync(join(import.meta.dirname, '..', '..', 'web/src/styles.css'), 'utf8');

  it('有 :focus-visible 规则，而且画的是 outline', () => {
    const m = css.match(/:focus-visible\s*\{[^}]*\}/);
    expect(m, '样式表里没有 :focus-visible 规则').toBeTruthy();
    expect(m![0]).toMatch(/outline:\s*\d/);
  });

  it('焦点环用第二版油墨，两套纸上都够醒目（WCAG 要 ≥3:1）', () => {
    expect(css).toMatch(/:focus-visible[\s\S]{0,120}var\(--blue\)/);
    for (const p of [LIGHT, DARK]) {
      const r = contrast(p.blue, p.paper);
      expect(r, `${p.blue} 压在 ${p.paper} 上只有 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('有 outline-offset，不然环会贴着字看不清', () => {
    expect(css).toMatch(/outline-offset:\s*\d/);
  });
});

describe('红色的用法', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8');

  /** 允许出现红的地方，以及为什么。加条目请连理由一起写。 */
  const ALLOWED: Array<{ file: string; why: string }> = [
    { file: 'web/src/pages/HomePage.tsx', why: '删除词条：真的破坏性操作' },
    { file: 'web/src/pages/SettingsPage.tsx', why: '清除词典 key：真的破坏性操作' },
    { file: 'web/src/components/AudioPlayer.tsx', why: '浏览器不支持语音合成：系统故障，不是对他的判决' },
  ];

  /**
   * Recorder 是唯一一个**允许有红、但只允许这两处**的文件。
   * 文件级白名单在这儿不够用：它里面既有合法的红，也真的混进过三处发音判决的红
   * （对立词的 Tag、「第 N 个音发成了对立音」的 Alert、「✗ 听成 /x/」）。
   * 所以这一个文件按**行**核对——多一行红就红。
   */
  const RECORDER_REDS = [
    'danger={recording}',                                    // 正在录音，通用约定
    '<Alert type="error" showIcon closable message="评测出错"', // 系统故障，不是对他的判决
  ];

  const FILES = [
    'web/src/pages/NoteDetailPage.tsx', 'web/src/pages/NotesPage.tsx',
    'web/src/pages/StatsPage.tsx', 'web/src/pages/WordPage.tsx',
    'web/src/pages/PhonemePage.tsx', 'web/src/pages/PhonemesPage.tsx',
    'web/src/pages/ReviewPage.tsx',
    'web/src/components/NoteHits.tsx', 'web/src/components/OverprintStrip.tsx',
    'web/src/components/PhonemeBar.tsx', 'web/src/components/PlaceRuler.tsx',
    'web/src/components/InkSetting.tsx', 'web/src/components/Offline.tsx',
  ];

  it.each(FILES)('%s 里不出现红——它没有破坏性操作', (f) => {
    const src = read(f);
    // antd 的红：type="error" / color="error" / type="danger" / danger 属性
    const reds = [/type=["']error["']/, /color:\s*['"]error['"]/, /color=["']error["']/,
      /type=["']danger["']/, /danger(?!-)/];
    // 注释里提到 error/danger 不算——那多半正是在解释为什么**不**用它
    const code = src.split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const re of reds) {
      expect(re.test(code), `${f} 里用了红：${re}`).toBe(false);
    }
  });

  it('Recorder 里只允许那两处红，多一处就是又拿红判发音了', () => {
    // 先剥块注释再扫。`{/* … */}` 的**续行**既不以 // 也不以 * 开头，
    // 只按行首过滤的话，一句解释"为什么这里保留 danger"的注释会被当成一处红。
    const code = stripComments(read('web/src/components/Recorder.tsx')).split(SPLIT_LINES);
    // `color={cond ? 'error' : …}` 这种 JSX 表达式里的红，前面那几条都漏——
    // 「念成了对立词」那个 Tag 就是这么写的，变异测试才逼出来。
    // 只匹配 color={…} 里面的，不匹配裸的 'error'：那会误伤 modelState === 'error'
    // 这类**状态值**，跟颜色无关。
    const red = /type=["']error["']|color:\s*['"]error['"]|color=["']error["']|color=\{[^}]*['"]error['"]|type=["']danger["']|danger(?!-)/;
    const found = code.filter((l) => red.test(l)).map((l) => l.trim());
    expect(found).toHaveLength(RECORDER_REDS.length);
    for (const f of found) {
      expect(RECORDER_REDS.some((a) => f.startsWith(a)), `多出一处红：${f}`).toBe(true);
    }
  });

  it('白名单本身要说得出理由——没理由的条目等于没有白名单', () => {
    for (const a of ALLOWED) expect(a.why.length, a.file).toBeGreaterThan(6);
  });
});
