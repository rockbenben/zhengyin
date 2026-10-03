import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { EntryDetail } from '../types';

const stub = vi.hoisted(() => ({
  offline: false,
  // null = 库里没有这个词；放一条 entry 进来就是"查到了"的整页
  entry: null as EntryDetail | null,
  // 边车健康：默认没就绪（状态条该出现，且**整页只出现一份**）
  health: { ok: false, uv: true } as { ok: boolean; uv?: boolean },
}));
vi.mock('../api', () => ({
  api: {
    getEntry: () => (stub.entry
      ? Promise.resolve(stub.entry)
      : Promise.reject(new Error(stub.offline ? '连不上' : '404'))),
    pronounceHealth: () => Promise.resolve(stub.health),
    getMwKey: () => Promise.resolve({ configured: true, masked: '••••1234' }),
    confusions: () => Promise.resolve({ contrasts: [] }),
    articulation: () => Promise.resolve({ places: [], manners: {}, phones: [] }),
    pronounce: () => Promise.reject(new Error('本测试不评测')),
    asr: () => Promise.reject(new Error('本测试不转写')),
    star: () => Promise.resolve({ starred: false, card: null }),
  },
  // 桩必须把 isOffline 也给出来：页面靠它区分"连不上服务"和"库里没有这个词"，
  // 漏了的话 catch 里自己抛异常，错误状态根本设不上——这一条就是这么红的。
  isOffline: () => stub.offline,
}));
vi.mock('../lib/asr', () => ({
  checkModelAvailability: () => Promise.resolve('missing'),
  contrastAll: () => Promise.resolve([]),
  resetModel: () => {},
}));

const { default: WordPage } = await import('./WordPage');

const word = (t: string) => ({
  word: t, found: true, arpabet: [], ipa: '', tags: [],
  phoneIpa: [], phoneTags: [], syllables: [], syllableStress: [],
});
const TWO_WORDS: EntryDetail = {
  text: 'dopamine detox', createdAt: '',
  words: [word('dopamine'), word('detox')] as EntryDetail['words'],
  audio: [], notes: [], review: null, phraseAudio: null,
} as EntryDetail;

/**
 * 词条页的空状态——库里没有这个词的时候。
 *
 * 原来只写「去问 AI，讲解后会自动出现在这里」。那句话在这个功能刚做出来时
 * 是实情，**后来就不是了**：首页那个输入框按「查这个词」就能建，音标、真人录音、
 * 音素条、评测全自动配好。把唯一的出路指向另一个软件，等于让人干等。
 *
 * 这一节守两件事：
 *   一、空状态给的是**他自己就能做**的那一步，而且给得出可点的入口
 *   二、词条和讲解要分开说——词条他自己建，讲解才需要 AI 写
 */
async function draw() {
  stub.offline = false;
  stub.entry = null;
  const { container } = render(
    <MemoryRouter initialEntries={['/word/coffee']}>
      <Routes><Route path="/word/:text" element={<WordPage />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(container.textContent).toContain('这个词'));
  return container;
}

describe('库里没有这个词时', () => {
  it('说明文字本身就要讲清他能自己建，不能全靠那个按钮', async () => {
    // 断言得**避开按钮**：整页 textContent 里有「查这个词」，可那四个字是按钮上的。
    // 拿整页断言的话，把说明换成「等着吧。」照样绿——变异测试里它真的活下来过。
    const sub = (await draw()).querySelector('.result-body')?.textContent ?? '';
    expect(sub, '说明文字没讲他能自己建').toMatch(/查这个词|自己建/);
    expect(sub, '没说建完能得到什么').toMatch(/音标|录音|评测/);
  });

  it('那一步要有可点的入口，不能只是一句话', async () => {
    const c = await draw();
    const home = [...c.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/');
    expect(home, '没有回首页的入口').toBeDefined();
  });

  it('入口上的字跟首页那个按钮一字不差——同一个动作不能有两个名字', async () => {
    // 首页那个按钮写的是「查这个词」（HomePage 的 enterButton）
    const c = await draw();
    const home = [...c.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/');
    expect(home!.textContent).toContain('查这个词');
  });

  it('讲解那一半还是要说清楚归 AI 写——两件事别混成一件', async () => {
    const text = (await draw()).textContent ?? '';
    expect(text).toMatch(/AI/);
  });
});

/**
 * 「连不上服务」必须是**另一屏**。
 *
 * 原来所有失败都走同一个空状态，于是把服务关掉之后，每个词条页都说
 * 「库里还没有这个词」，还请你回首页去建——而首页同样连不上。
 * 一个本地工具最常见的故障（启动的那个窗口被关掉了），界面给的是一条走不通的路。
 */
describe('连不上服务时', () => {
  async function drawOffline() {
    stub.offline = true;
    stub.entry = null;
    const { container } = render(
      <MemoryRouter initialEntries={['/word/coffee']}>
        <Routes><Route path="/word/:text" element={<WordPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent).toMatch(/连不上|服务/));
    return container;
  }

  it('说的是连不上，不是"库里没有这个词"', async () => {
    const text = (await drawOffline()).textContent ?? '';
    expect(text, '把"连不上"说成了"库里没有"').not.toContain('库里还没有');
    expect(text).toMatch(/连不上/);
  });

  it('给的是真能走通的一步——去把服务起起来', async () => {
    const text = (await drawOffline()).textContent ?? '';
    expect(text, '没说怎么把服务起回来').toMatch(/启动/);
    // 不许说"稍后重试"：等多久服务都不会自己起来
    expect(text).not.toMatch(/稍后重试/);
  });

  it('不要把人往首页赶——那儿同样连不上', async () => {
    const c = await drawOffline();
    const home = [...c.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/');
    expect(home, '连不上的时候还给了一个走不通的首页入口').toBeUndefined();
  });
});

/**
 * 识别服务的状态条是**这台机器的状态**，不是每个音节的状态。
 *
 * 原来它长在 Recorder 里，而词条页逐音节各摆一个 Recorder——两个音节的短语
 * 就把同样的三行字整份读两遍（90 秒后的升级态同样 ×2）。现在归 AsrStatus，
 * 页面挂一次。这条钉的是相等关系「整页份数 === 1」，不是某个具体文案。
 */
describe('两音节短语页上，识别服务状态条恰好一份', () => {
  it('「正在加载模型」整页只出现一次', async () => {
    stub.offline = false;
    stub.entry = TWO_WORDS;
    stub.health = { ok: false, uv: true };
    const { unmount } = render(
      <MemoryRouter initialEntries={['/word/dopamine%20detox']}>
        <Routes><Route path="/word/:text" element={<WordPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.body.textContent).toContain('音素识别服务正在加载模型'));
    const count = (document.body.textContent?.match(/音素识别服务正在加载模型/g) ?? []).length;
    unmount();
    expect(count, `状态条重复了 ${count} 份`).toBe(1);
  });
});
