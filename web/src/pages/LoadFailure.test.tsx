import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

/**
 * 服务没起来时，每一页都得说清**怎么办**。
 *
 * ── 这个文件为什么存在 ──
 *
 * 「所有文案检查一遍」时发现，同一次故障在五个页面上有三种说法，而且没有一种
 * 给得出下一步：
 *
 *   · `/phonemes` —— `.catch(() => setD(null))` 撞上 `if (!d) return null`，
 *     **整页白屏**。点了侧栏的「音素」什么都不发生，连一句话都没有。
 *   · `/phoneme/<ipa>` —— 任何失败都当成「没有这个音素」，于是服务一停，
 *     它说「音标里的符号一个都不能差」。**拿一句拼写指责去回答一次网络故障**，
 *     而他的音标一个字都没错——从评测结果点音标跳过来，正好撞上。
 *   · 笔记 / 复习 / 统计 / 设置 —— 「服务可能没启动，稍后重试」：点出了原因，
 *     却跟着一句治不了它的建议。服务没起来，重试一百次也还是没起来。
 *
 * 这些都活了下来，因为**一条失败路径都没有测试**。所以这里守住那条底线：
 * 连不上时页面不能空白，而且必须出现能照做的下一步（去双击启动那个文件）。
 * 断言不锁具体文案，只锁"说了怎么启动"。
 */

const stub = vi.hoisted(() => ({ mode: 'offline' as 'offline' | 'error' | 'missing' }));

function boom() {
  if (stub.mode === 'offline') {
    const e = new Error('连不上') as Error & { offline: true };
    (e as { offline?: boolean }).offline = true;
    return Promise.reject(e);
  }
  return Promise.reject(new Error(stub.mode === 'missing' ? 'API 404' : 'API 500'));
}

vi.mock('../api', () => ({
  isOffline: (e: unknown) => !!(e as { offline?: boolean })?.offline,
  api: {
    phonemes: boom, phoneme: boom, listNotes: boom, stats: boom,
    articulation: boom, reviewDue: boom, getMwKey: boom,
  },
}));

const { default: PhonemesPage } = await import('./PhonemesPage');
const { default: PhonemePage } = await import('./PhonemePage');
const { default: NotesPage } = await import('./NotesPage');
const { default: StatsPage } = await import('./StatsPage');

/**
 * 那块「服务没起来」的屏认得出来的标志：它叫你去**双击**启动那个文件。
 *
 * 不能拿 /启动/ 当标志——另一块「这次请求出错了」的屏里有「看启动那个窗口里的
 * 报错」，同样含「启动」二字。两块屏要能分开，标志就得挑只有一边有的那个词。
 */
const SAYS_HOW = /双击/;

beforeEach(() => { stub.mode = 'offline'; });

function draw(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>).container;
}

describe('连不上服务时，页面不能白着也不能瞎猜', () => {
  it('音素表：不是白屏，而且说得出怎么把服务起起来', async () => {
    const c = draw(<PhonemesPage />);
    await waitFor(() => expect(c.textContent).toMatch(SAYS_HOW));
    expect(c.textContent!.trim(), '整页空白').not.toBe('');
  });

  it('笔记', async () => {
    const c = draw(<NotesPage />);
    await waitFor(() => expect(c.textContent).toMatch(SAYS_HOW));
  });

  it('统计', async () => {
    const c = draw(<StatsPage />);
    await waitFor(() => expect(c.textContent).toMatch(SAYS_HOW));
  });

  it('**不能把网络故障说成拼写错误**——他的音标一个字都没错', async () => {
    const c = render(
      <MemoryRouter initialEntries={['/phoneme/%C9%99']}>
        <Routes><Route path="/phoneme/:ipa" element={<PhonemePage />} /></Routes>
      </MemoryRouter>,
    ).container;
    await waitFor(() => expect(c.textContent).toMatch(SAYS_HOW));
    expect(c.textContent, '把连不上说成了音标打错').not.toMatch(/符号一个都不能差|没有这个音素/);
  });

  it('真的没有这个音素时，才说没有这个音素', async () => {
    stub.mode = 'missing';
    const c = render(
      <MemoryRouter initialEntries={['/phoneme/zz']}>
        <Routes><Route path="/phoneme/:ipa" element={<PhonemePage />} /></Routes>
      </MemoryRouter>,
    ).container;
    await waitFor(() => expect(c.textContent).toMatch(/没有这个音素/));
  });

  it('服务在跑、只是这次失败 → 给刷新，不叫人去启动已经在跑的服务', async () => {
    stub.mode = 'error';
    const c = draw(<PhonemesPage />);
    await waitFor(() => expect(c.textContent).toMatch(/刷新/));
    expect(c.textContent).not.toMatch(SAYS_HOW);
  });
});
