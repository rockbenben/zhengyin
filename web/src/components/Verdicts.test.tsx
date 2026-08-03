import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Verdicts from './Verdicts';
import type { ContrastVerdict } from '../lib/asr';

/**
 * 降级路径（vosk 二选一）的四种结局。
 *
 * ── 这个文件为什么存在 ──
 *
 * Verdicts 原来长在 Recorder.tsx 里、不导出，于是**一条测试都没有**——
 * 三个测试文件都把 contrastAll 打桩成返回 `[]`，这段渲染从来没执行过。
 * 而边车连不上正是这个应用第一号故障（启动时那个窗口被关掉），
 * 它恰恰是那时候唯一还能给结论的一屏：**最该稳的一段，反而最没人看着。**
 *
 * 这里守两条硬规矩，四个分支逐个查：
 *   · 自报家门：说不出你实际发的是什么音，这句话不能省
 *   · 不许用红：theme.ts「红色只留给真正的破坏性操作」
 */
const V = (over: Partial<ContrastVerdict>): ContrastVerdict => ({
  word: 'thing', index: 2, targetIpa: 'n', partnerIpa: 'ŋ',
  winner: 'target', conf: 0.9, ...over,
} as ContrastVerdict);

function draw(over: Over = {}) {
  const { container } = render(
    <MemoryRouter>
      <Verdicts target="thin" verdicts={[V({})]} diff={null} why="边车没起来" {...over} />
    </MemoryRouter>,
  );
  return container;
}

type Over = Partial<Parameters<typeof Verdicts>[0]>;

// 不写 `as const`：那会把元素变成 readonly，赋不进 Partial<Props>。
// 而 `npm test`（vitest）**不做类型检查**，所以这个错只有 `npm run build` 才会红。
const 四种: Array<[string, Over]> = [
  ['没有可比的对立音', { verdicts: [] }],
  ['念成了对立音', { verdicts: [V({ winner: 'partner' })] }],
  ['没听清', { verdicts: [V({ winner: null })] }],
  ['都分得开', { verdicts: [V({ winner: 'target' })] }],
];

describe('降级路径：四种结局都得自报家门', () => {
  it.each(四种)('%s → 说清楚这条路测不出你实际发的是什么音', (_label, over) => {
    const t = draw(over).textContent ?? '';
    expect(t, '没说这是弱办法').toMatch(/弱办法|两个词里挑一个|说不出你实际发的/);
  });

  it.each(四种)('%s → 如实带上"为什么退到这条路"', (_label, over) => {
    expect(draw(over).textContent).toContain('边车没起来');
  });
});

/**
 * 不许用红。theme.ts 顶上：「刻意不用红色报错……"对/错"是评判，红色只留给
 * 真正的破坏性操作」。主路径（套印带）里发错的音就是用第二版油墨画的，
 * 这条降级路径得跟它一致，不能自己另立一套配色。
 */
describe('降级路径不许用红——那是留给破坏性操作的', () => {
  it.each(四种)('%s → 没有 antd 的 error 样式', (_label, over) => {
    const c = draw(over);
    expect(c.querySelector('.ant-alert-error'), '用了报错红').toBeNull();
  });

  it('念成了对立音那一档用琥珀（提醒），不是红', () => {
    const c = draw({ verdicts: [V({ winner: 'partner' })] });
    expect(c.querySelector('.ant-alert-warning')).not.toBeNull();
  });

  it('「听成了对面那个音」那行用第二版油墨，跟主路径一致', () => {
    const c = draw({ verdicts: [V({ winner: 'partner' })] });
    const hit = [...c.querySelectorAll<HTMLElement>('*')]
      .find((e) => e.textContent?.startsWith('✗') && e.children.length === 0);
    expect(hit, '没找到那一行').toBeDefined();
    expect(hit!.style.color, '没用第二版油墨').toContain('--blue');
  });
});

describe('降级路径：各档说的是不是自己那件事', () => {
  // **只查标题**，不查整页文本：下面每一行本来就印着「第 N 个音」的标签，
  // 拿整页断言的话，标题改成「有音发成了对立音」照样绿——变异实测活下来过。
  // 要守的是"抬头一句就点名位置"，人扫一眼就知道错在哪。
  it('念成了对立音 → 标题里就点名第几个音', () => {
    const c = draw({ verdicts: [V({ winner: 'partner', index: 2 })] });
    // antd 6 的类名是 .ant-alert-title（5 之前叫 .ant-alert-message）。
    // 取第一个：外层那条 warning 的标题，里面那条自报家门的 banner 排在后面。
    const title = c.querySelector('.ant-alert-title')?.textContent ?? '';
    expect(title, '取不到标题——antd 换类名了？').not.toBe('');
    expect(title, '标题没说错在第几个音').toMatch(/第 3 个音/);
  });

  it('全都分得开 → 说明"分得开不等于发音标准"', () => {
    const t = draw({ verdicts: [V({ winner: 'target' })] }).textContent ?? '';
    expect(t, '把"没混"说成了"念得标准"').toMatch(/不等于发音标准|测不出来/);
  });

  it('没听清 → 给下一步（再录一次），不是只说结论', () => {
    const t = draw({ verdicts: [V({ winner: null })] }).textContent ?? '';
    expect(t).toMatch(/再录一次/);
  });

  // 一条对立音都配不出来时，得说清楚**为什么**配不出来、怎么才能有——
  // 只说"没有可比的对立音"等于把人晾在那儿。
  it('没有对立音 → 说清楚对比项是从笔记来的，写一篇就会有', () => {
    const t = draw({ verdicts: [] }).textContent ?? '';
    expect(t).toMatch(/笔记/);
  });

  it('输掉的那处有笔记时，把链接摆出来', () => {
    const c = draw({
      verdicts: [V({ winner: 'partner' })],
      diff: { match: false, subs: [], notes: [{ id: 'n-vs-ng', title: '前后鼻音不分', severity: 'info' }] },
    });
    const a = [...c.querySelectorAll('a')].find((x) => x.getAttribute('href') === '/notes/n-vs-ng');
    expect(a, '有笔记却没给链接').toBeDefined();
    expect(a!.textContent).toContain('前后鼻音不分');
  });
});
