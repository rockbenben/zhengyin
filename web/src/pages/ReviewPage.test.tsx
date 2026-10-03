import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AlignOp, PronounceResult } from '../types';

/**
 * 复习页：**屏幕上写的话，和它给的动作，必须是同一件事。**
 *
 * ── 这个文件为什么存在 ──
 *
 * 这一页原来一条测试都没有，于是下面这条自相矛盾一直活着：
 *
 * 模型判不出来时（没听出音 / 有几处没把握），判定文案写的是「再录一次」
 * 「再念一遍」，而底部**唯一**的动作是一个写着「下一个」的主按钮，
 * 空格也绑在它上面。**嘴上让人重录，手上只给跳过**——而且按空格会把一张
 * 根本没判过的卡悄悄翻过去：它没打分，所以还会回来，人却不知道刚才发生了什么。
 *
 * 现在那一档换成「再念一遍」（回到录音条）+「跳过这张」，空格只在真判出
 * 结果时才管用。这里守的就是这条对应关系，不锁具体文案。
 *
 * 后来这一页又清掉了第二件从 Anki 抄来的东西：**藏答案**。要练的是舌头的动作，
 * 不是记忆；藏掉标准音等于让人先凭错的动作念一遍。下面第一个 describe 守着它。
 */

const stub = vi.hoisted(() => ({
  graded: [] as Array<{ text: string; grade: string }>,
  result: null as PronounceResult | null,
  starred: false,
  /** 队列空不空，由用例定 */
  empty: false,
  /** 队列里还没到期的：几张、最早哪天 */
  upcoming: { count: 0, next: null as string | null },
}));

vi.mock('../api', () => ({
  isOffline: () => false,
  api: {
    reviewDue: () => Promise.resolve({
      cards: stub.empty ? [] : [{ text: 'thin', rung: 0, due: '2026-08-01', starred: stub.starred }],
      upcoming: stub.upcoming,
    }),
    getEntry: (t: string) => Promise.resolve({
      text: t, createdAt: '', words: [{ word: t, found: true, arpabet: [], ipa: 'θɪn', tags: [], phoneIpa: [], phoneTags: [], syllables: [], syllableStress: [] }],
      audio: [], phraseAudio: null, notes: [], review: null,
    }),
    reviewGrade: (text: string, grade: string) => {
      stub.graded.push({ text, grade });
      return Promise.resolve({ graduated: false });
    },
  },
}));

// 真 Recorder 要麦克风和识别服务。换成一个按钮，点一下就把预设的判定结果交上去。
vi.mock('../components/Recorder', () => ({
  default: ({ onResult }: { onResult: (r: PronounceResult) => void }) => (
    <button type="button" onClick={() => onResult(stub.result!)}>录音替身</button>
  ),
}));
// 不渲染成 null：下面要断言「标准音在录音前就摆着」，得看得见它
vi.mock('../components/AudioPlayer', () => ({ default: () => <span>标准音替身</span> }));
vi.mock('../components/PhonemeBar', () => ({ default: () => null }));
vi.mock('../components/NoteHits', () => ({ default: () => null }));
// 真 AsrStatus 要问识别服务健康、要探备用模型的文件，跟本页要测的复习流转无关
vi.mock('../components/AsrStatus', () => ({ default: () => null }));

const { default: ReviewPage } = await import('./ReviewPage');

const op = (kind: AlignOp['kind'], sure: boolean): AlignOp =>
  ({ kind, targetIpa: 'θ', heardIpa: 'f', sure } as AlignOp);

/** 每个音都对 */
const ALL_OK: PronounceResult = {
  heardIpa: ['θ', 'ɪ', 'n'], align: [op('match', true), op('match', true), op('match', true)],
} as unknown as PronounceResult;

/** 有确凿的错 */
const WRONG: PronounceResult = {
  heardIpa: ['f', 'ɪ', 'n'], align: [op('sub', true), op('match', true), op('match', true)],
} as unknown as PronounceResult;

/** 有拿不准的错——判不出来的那一档 */
const UNSURE: PronounceResult = {
  heardIpa: ['f', 'ɪ', 'n'], align: [op('sub', false), op('match', true), op('match', true)],
} as unknown as PronounceResult;

beforeEach(() => {
  stub.graded = []; stub.result = null; stub.starred = false;
  stub.empty = false; stub.upcoming = { count: 0, next: null };
});

async function drawAndRecord(result: PronounceResult) {
  stub.result = result;
  const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
  const rec = await waitFor(() => {
    const b = [...container.querySelectorAll('button')].find((x) => x.textContent === '录音替身');
    expect(b).toBeDefined();
    return b!;
  });
  fireEvent.click(rec);
  return container;
}

const buttons = (c: HTMLElement) =>
  [...c.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

describe('判不出来时，说的和给的必须是同一件事', () => {
  it('模型没把握 → 给「再念一遍」，不是只给「下一个」', async () => {
    const c = await drawAndRecord(UNSURE);
    await waitFor(() => expect(c.textContent).toMatch(/没把握|不计入进度/));
    expect(buttons(c).some((t) => /再念|再录/.test(t)), `按钮只有：${buttons(c).join('、')}`).toBe(true);
  });

  it('跳过是有的，但降成次要动作，而且说明白不计进度', async () => {
    const c = await drawAndRecord(UNSURE);
    await waitFor(() => expect(c.textContent).toMatch(/不计入进度/));
    expect(buttons(c).some((t) => /跳过/.test(t))).toBe(true);
  });

  it('**空格不能把没判过的卡翻过去**——快捷键不能跟屏幕上写的话对着干', async () => {
    const c = await drawAndRecord(UNSURE);
    await waitFor(() => expect(c.textContent).toMatch(/不计入进度/));
    fireEvent.keyDown(window, { key: ' ' });
    await new Promise((r) => setTimeout(r, 60));
    // 没判出结果本来就不该打分；关键是它也不该**换一张卡**
    expect(stub.graded).toEqual([]);
    expect(c.textContent, '空格把这张卡翻过去了').toMatch(/不计入进度/);
  });
});

describe('判得出来的两档照旧', () => {
  it('每个音都对 → remembered，空格能过', async () => {
    const c = await drawAndRecord(ALL_OK);
    await waitFor(() => expect(c.textContent).toMatch(/每个音都对/));
    expect(buttons(c).some((t) => t === '下一个')).toBe(true);
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(stub.graded).toEqual([{ text: 'thin', grade: 'remembered' }]));
  });

  it('有确凿的错 → forgot', async () => {
    const c = await drawAndRecord(WRONG);
    await waitFor(() => expect(c.textContent).toMatch(/发音不对/));
    fireEvent.keyDown(window, { key: ' ' });
    await waitFor(() => expect(stub.graded).toEqual([{ text: 'thin', grade: 'forgot' }]));
  });
});

/**
 * 一进卡就把要练的东西全摆出来。
 *
 * 这一页曾经藏着音标和标准音，要你先录一遍才揭晓——那是闪卡的做法，
 * 前提是"回忆不出来"本身有价值。而这里要练的是**舌头的动作**：
 * 藏掉标准音，人就只能凭已有的（错的）动作念一遍，然后被告知错了，
 * 这才让他听正确的——先把错的练了一遍。
 */
describe('要练的东西一进卡就摆着，不用先录', () => {
  async function drawOnly() {
    stub.result = ALL_OK;
    const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await waitFor(() => expect(container.textContent).toContain('thin'));
    return container;
  }

  it('还没录，音标就在', async () => {
    const c = await drawOnly();
    await waitFor(() => expect(c.textContent, '音标被藏起来了').toContain('θɪn'));
  });

  it('还没录，标准音就在', async () => {
    const c = await drawOnly();
    await waitFor(() => expect(c.textContent, '标准音被藏起来了').toContain('标准音替身'));
  });

  it('判定条要等录完才出现——没测过就没有判定', async () => {
    const c = await drawOnly();
    expect(buttons(c), '还没录就冒出「下一个」').not.toContain('下一个');
  });

  // 原来这儿是「不会，直接看答案」，而且它按"忘了"记分。现在答案本来就摆着，
  // 跳过是**没录音**——没录音就没有证据，不该有分数。
  it('不想练这张可以跳过，而且不打分', async () => {
    const c = await drawOnly();
    const skip = [...c.querySelectorAll('button')].find((b) => /跳过/.test(b.textContent ?? ''));
    expect(skip, '没给跳过的出口，人会卡在这张卡上').toBeDefined();
    fireEvent.click(skip!);
    await waitFor(() => expect(c.textContent).toMatch(/复习完了|没有要复习/));
    expect(stub.graded, '跳过不该产生分数').toEqual([]);
  });
});

/**
 * 手动加进来的那张卡，标签得跟星标按钮用同一个词。
 *
 * 按钮写「加入复习 / 移出复习」，点完弹「已加入复习」，而这一页原来把它叫
 * 「你**收藏**的」——StarButton 的注释里明写着这个说法在应用里根本不存在，
 * 它自己的测试也拦着弹窗里出现它。**拦了弹窗，漏了这个标签**，于是那个不存在的
 * 第三种说法就活在复习页上。（桩里的卡片一直没有 starred，这一行从没被渲染过。）
 */
describe('手动加进来的卡，说法跟星标按钮一致', () => {
  it('不说「收藏」——按钮和提示都只说「加入复习」', async () => {
    stub.starred = true;
    const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await waitFor(() => expect(container.textContent).toContain('thin'));
    expect(container.textContent, '「收藏」这个说法整个应用里都没有').not.toMatch(/收藏/);
  });

  it('没加星的那张说「之前念错过」，两档没串', async () => {
    const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await waitFor(() => expect(container.textContent).toContain('thin'));
    expect(container.textContent).toContain('之前念错过');
  });
});

/**
 * 空队列不是只有一种。
 *
 * 这一页原来只分「刚复习完 N 张」和「其余」，于是**队列里有卡、只是今天还没到期**
 * 时落进后一档，屏幕上说的是「复习队列只收有证据的词……去首页录一次音」——
 * 而新卡默认第二天到期（review.ts 的 addCard），刚在单词页点完「加入复习」的人
 * 正是从那儿走过来的：他加了四个词，页面却说得像一个都没有。
 *
 * 那不是措辞粗糙，是句假话。这里守三档各自说各自的话。
 */
describe('空队列分三档说话', () => {
  it('队列里有没到期的卡时，说清还剩几个、什么时候到期，不说「去录一次音」', async () => {
    stub.empty = true;
    stub.upcoming = { count: 4, next: '2999-01-01' };
    const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await waitFor(() => expect(container.textContent).toMatch(/没有要复习/));
    expect(container.textContent).toContain('4');
    expect(
      container.textContent,
      '队列里明明有四个词，不能再说「只收有证据的词、去首页录一次音」',
    ).not.toMatch(/只收|录一次音/);
  });

  it('真的一张都没有时，才说清什么会让队列有东西', async () => {
    stub.empty = true;
    stub.upcoming = { count: 0, next: null };
    const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await waitFor(() => expect(container.textContent).toMatch(/没有要复习/));
    expect(container.textContent).toMatch(/有证据/);
  });

  it('服务端没给 upcoming（旧响应）也不崩，按「没有待办」渲染', async () => {
    stub.empty = true;
    stub.upcoming = undefined as unknown as { count: number; next: string | null };
    const { container } = render(<MemoryRouter><ReviewPage /></MemoryRouter>);
    await waitFor(() => expect(container.textContent).toMatch(/没有要复习/));
    expect(container.textContent).toMatch(/有证据/);
  });
});
