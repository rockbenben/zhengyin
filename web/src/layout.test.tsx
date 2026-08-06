import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stub = vi.hoisted(() => ({ due: 0, attempts: 12 }));

vi.mock('./api', () => ({
  api: {
    reviewDue: () => Promise.resolve({ cards: Array.from({ length: stub.due }, () => ({})) }),
    stats: () => Promise.resolve({ overall: { attempts: stub.attempts } }),
    // UserSwitcher 现在也挂在侧栏里，会调这个。这些测试不关心用户切换，拒绝掉让
    // 它按设计返回 null（服务连不上时整个不渲染），不给这批断言添别的变量。
    user: () => Promise.reject(new Error('not mocked in layout.test.tsx')),
  },
}));

const { default: AppLayout } = await import('./layout');

/**
 * 侧栏。
 *
 * ── 这个文件为什么存在 ──
 *
 * 首页原来用大字写「有 7 个词要复习」并配一个「开始复习」按钮，同一件事在一屏里
 * 说三遍（侧栏角标、标题、按钮）。拿掉重复的那两处是对的，但**守着「到期数必须
 * 改变用户看到的东西」的测试全在 HomePage.test.tsx 里**——照着删就等于把这条
 * 保证一起删了，而它并没有失效，只是换了地方。
 *
 * 这个仓库正是在这种事上栽过两次（comparedWith 一路铺到 types.ts 却一个字都没渲染、
 * referenceUrl 为 null 时按钮默默变灰）：**声明了但没用，类型检查看不出来。**
 * 所以保证跟着行为走，不跟着文件走。
 *
 * 断言不锁文案，锁的是：有到期时那个数字看得见，没有时不摆一个 0 在那儿占地方。
 */
function draw() {
  return render(<MemoryRouter><AppLayout /></MemoryRouter>).container;
}

beforeEach(() => {
  stub.due = 0;
  stub.attempts = 12;
});

describe('侧栏是复习入口唯一的常驻位置', () => {
  it('有到期的 → 数字必须看得见', async () => {
    stub.due = 7;
    const c = draw();
    await waitFor(() => expect(c.querySelector('.due-count')?.textContent).toBe('7'));
  });

  it('没有到期的 → 不摆一个 0 在那儿', async () => {
    const c = draw();
    await waitFor(() => expect(c.textContent).toMatch(/复习/));
    expect(c.querySelector('.due-count')).toBeNull();
  });

  it('有和没有，渲染结果必须不同——这条保证从首页搬过来，不能在搬家途中掉了', async () => {
    stub.due = 0;
    const none = draw();
    await waitFor(() => expect(none.textContent).toMatch(/复习/));
    stub.due = 5;
    const some = draw();
    await waitFor(() => expect(some.querySelector('.due-count')).not.toBeNull());
    expect(some.textContent).not.toBe(none.textContent);
  });

  it('复习始终在导航里，跟到期数无关——没到期不等于不能主动去练', async () => {
    const c = draw();
    await waitFor(() => expect(c.textContent).toMatch(/复习/));
    expect([...c.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/review')).toBe(true);
  });
});

/**
 * 窄到 lg 以下侧栏收成零宽，只剩 antd 甩出来的那个重开按钮。实测 390px 下它
 * 绝对定位在内容之上，把八个页面的标题或副标题**全**盖掉一角；而且它是个
 * `tabIndex: -1` 的 `<span>`，键盘按不到——那一档整个导航对键盘用户不可达。
 *
 * jsdom 的 matchMedia 一律返回 matches:false，也就是"不到 lg"，所以这个按钮
 * 在测试环境里本来就渲染得出来，能直接测行为。
 */
describe('从一页走到另一页', () => {
  it('第一个能 Tab 到的东西是「跳到正文」，而且它指向 main', async () => {
    const c = draw();
    await waitFor(() => expect(c.textContent).toMatch(/复习/));
    const focusable = c.querySelectorAll('a[href],button,input,[tabindex]:not([tabindex="-1"])');
    expect(focusable[0]?.textContent, '第一个可聚焦的不是跳过导航的入口').toBe('跳到正文');
    const target = focusable[0].getAttribute('href')!.slice(1);
    expect(c.querySelector(`#${target}`), '跳过去的落点不存在').not.toBeNull();
  });

  // 它必须留在 tab 序里。display:none / visibility:hidden 会把它摘掉，等于没做——
  // 而那两种写法在屏幕上跟 left:-9999px 看着一模一样。
  it('平时看不见，但不能从 tab 序里摘掉', () => {
    const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
    const rule = css.match(/\.skip-link\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule, '没有 .skip-link 这条规则').toBeTruthy();
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(css, '聚焦时没有把它挪回可见处').toMatch(/\.skip-link:focus\s*\{/);
  });

  // antd 只给 .ant-menu-item-selected 这个类，那是画给眼睛看的。
  it('当前所在的那一页，导航里要说得出来', async () => {
    const c = draw();
    await waitFor(() => expect(c.textContent).toMatch(/复习/));
    const cur = [...c.querySelectorAll('a[aria-current="page"]')];
    expect(cur.length, 'aria-current 不是恰好一个').toBe(1);
    expect(cur[0].getAttribute('href')).toBe('/');
  });
});

/**
 * 用户输进来的词会出现在大字标题和词条表里，而那可以是任意长度。
 * jsdom 没有布局，量不出溢出，所以这里守的是那两条规则本身——它们各自都有
 * 一个"看着对、其实没用"的近邻写法，实测踩过。
 */
describe('长词不能把整页撑成横向滚动', () => {
  const css = () => readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

  it('大字标题用 anywhere，不能退成 break-word', () => {
    const rule = css().match(/\.display\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule, '没有 .display 这条规则').toBeTruthy();
    // break-word 不参与 min-content 计算：网格轨道照样按整词宽度撑开，
    // 计算样式显示已生效、页面却还是横滚（390px 下实测 872px）。
    expect(rule, '.display 用了 break-word，那个不收 min-content').not.toMatch(/overflow-wrap:\s*break-word/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('词条表在自己的容器里横滚', () => {
    // 试过给单元格加 overflow-wrap，td 的计算值仍是 antd 那条 break-word——
    // 比特异性赢不了，也没必要：宽内容本来就该在自己的盒子里滚。
    expect(css(), '.ant-table-content 没有自己的横向滚动').toMatch(/\.ant-table-content\s*\{[^}]*overflow-x:\s*auto/);
  });
});

/** jsdom 的 matchMedia 一律 matches:false，等于"永远是宽屏"。窄屏要自己扮。 */
function pretendNarrow() {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    matches: /max-width/.test(q), media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => { window.matchMedia = real; };
}

describe('窄屏下导航还打得开', () => {
  it('重开按钮是真按钮、有中文可访问名', async () => {
    const restore = pretendNarrow();
    try {
      const c = draw();
      await waitFor(() => expect(c.querySelector('.ant-layout-sider-zero-width-trigger')).not.toBeNull());
      const btn = c.querySelector('.ant-layout-sider-zero-width-trigger button');
      expect(btn, 'antd 那个零宽触发器里没有自己的按钮，会退回不可聚焦的 span').not.toBeNull();
      expect(btn!.getAttribute('aria-label')).toMatch(/[一-鿿]/);
    } finally { restore(); }
  });

  it('宽屏不该多出这么一个按钮——侧栏本来就摊着', async () => {
    const c = draw();
    await waitFor(() => expect(c.textContent).toMatch(/复习/));
    expect(c.querySelector('.ant-layout-sider-zero-width-trigger')).toBeNull();
  });

  // 让位的横带在 styles.css，触发它的断点在 layout.tsx，两处对不上就会出现
  // "带子在、按钮不在"或者反过来。CSS 和 TSX 之间没有类型检查，只能让它会红。
  it('横带和按钮必须在同一个宽度出现', () => {
    const dir = import.meta.dirname;
    const tsx = readFileSync(join(dir, 'layout.tsx'), 'utf8');
    const css = readFileSync(join(dir, 'styles.css'), 'utf8');
    // 宽度值从 antd 自己那份表里取，不在这儿抄一份——抄的那份会随 antd 升级悄悄过期
    const sider = readFileSync(join(dir, '..', '..', 'node_modules', 'antd', 'lib', 'layout', 'Sider.js'), 'utf8');
    const bp = tsx.match(/breakpoint="(\w+)"/)?.[1];
    const width = sider.match(new RegExp(`\\b${bp}:\\s*[\`'"]([\\d.]+)px`))?.[1];
    expect(width, `antd 的 dimensionMaxMap 里查不到 breakpoint="${bp}"（antd 换结构了？）`).toBeTruthy();
    expect(css, `styles.css 里 .page 那条横带没跟 breakpoint="${bp}"（${width}px）对齐`)
      .toMatch(new RegExp(`@media\\s*\\(max-width:\\s*${width!.replace('.', '\\.')}px\\)[^}]*\\.page`));
  });
});
