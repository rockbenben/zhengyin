import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { StatsResult } from '../types';

const stub = vi.hoisted(() => ({ stats: null as StatsResult | null }));
vi.mock('../api', () => ({
  api: {
    stats: () => Promise.resolve(stub.stats),
    articulation: () => Promise.resolve({ places: [], manners: {}, phones: [] }),
  },
}));

const { default: StatsPage } = await import('./StatsPage');

/**
 * 「最常犯的错」那张表里，一行有三段东西：错法、哪些词上错的、哪篇讲解。
 *
 * 两段都栽在**没有分隔**上，而且是截图才看出来的：
 *
 * 一、词条之间只隔了 8px。词条名本身可以含空格（"dopamine detox"、"prompt prefix"），
 *     于是三个等距的词读成一个短语——实测显示成 `dopamine detox coffee`，
 *     而它其实是**两个词条**。
 *
 * 二、词条和讲解都是蓝链接、同一个字号，紧挨着排就分不出边界——
 *     实测读成 `thin  l / n 不分（边音 vs 鼻音）`，像是 thin 后面跟了串什么。
 *
 * 断言不锁具体符号（这个仓库文案改得勤），锁的是**边界看得出来**。
 */

function stats(over: Partial<StatsResult['phonemes'][number]> = {}): StatsResult {
  return {
    overall: { attempts: 94, clean: 10, words: 9, firstAt: '2026-07-31', lastAt: '2026-07-31' },
    stuck: [],
    phonemes: [{
      kind: 'sub', targetIpa: 'ɑ', heardIpa: 'æ', count: 25,
      words: ['dopamine detox', 'coffee'],
      notes: [{ id: 'a', title: '/ɑ/ 和 /æ/ 是两个音' }, { id: 'b', title: '前后鼻音不分' }],
      worthANote: true, lastAt: '2026-07-31',
      ...over,
    }] as StatsResult['phonemes'],
  };
}

async function draw(
  over: Partial<StatsResult['phonemes'][number]> = {},
  stuck?: StatsResult['stuck'],
) {
  stub.stats = { ...stats(over), ...(stuck === undefined ? { stuck: undefined } : { stuck }) } as StatsResult;
  const { container } = render(<MemoryRouter><StatsPage /></MemoryRouter>);
  await waitFor(() => expect(container.textContent).toContain('最常犯的错'));
  return container;
}

describe('最常犯的错：三段东西要分得开', () => {
  it('两个词条之间有分隔，不许糊成一个短语', async () => {
    const c = await draw();
    // 含空格的词条名紧挨着，中间什么都没有的话就是 `dopamine detoxcoffee`
    expect(c.textContent, '两个词条之间没有分隔符').not.toContain('detoxcoffee');
    expect(c.textContent, '只靠间距，读起来还是一个短语').not.toContain('detox coffee');
  });

  it('两篇讲解之间也有分隔', async () => {
    const c = await draw();
    expect(c.textContent).not.toContain('两个音前后鼻音');
  });

  it('讲解那一段自己报出名字，不然跟词条列连成一片', async () => {
    const c = await draw();
    expect(c.textContent, '讲解列没有标签').toContain('讲解');
  });

  it('只有一个词条时不该冒出一个多余的分隔符', async () => {
    const c = await draw({ words: ['dopamine detox'], notes: [] });
    expect(c.textContent).toContain('dopamine detox');
    expect(c.textContent).not.toMatch(/·\s*dopamine/);
  });

  it('没有讲解、而且够格补一篇 → 给出那个提示，且不出现「讲解」标签', async () => {
    const c = await draw({ notes: [], worthANote: true });
    expect(c.textContent).toContain('该补一篇');
    expect(c.textContent).not.toContain('讲解');
  });

  it('没有讲解、也不够格 → 什么都不标（标常态会把真该看的淹掉）', async () => {
    const c = await draw({ notes: [], worthANote: false });
    expect(c.textContent).not.toContain('该补一篇');
    expect(c.textContent).not.toContain('讲解');
  });
});

/**
 * 「卡住的词」——练了很多次、还是过不去的那些。
 *
 * 这份数据服务端一直在算，但**只喂给发音档案那个 md 文件**，只用网页的人看不到。
 * 而对他来说这恰恰是最可操作的一条：音素统计说"你 /n/ 错了 21 次"，
 * 这一块说"dopamine detox 你练了 54 次还是过不去"——直接回答"我今天该练什么"。
 */
describe('卡住的词', () => {
  const stuck = [{ text: 'dopamine detox', attempts: 54, clean: 3 }];

  it('列出来，而且点得进去', async () => {
    const c = await draw({}, stuck);
    expect(c.textContent).toContain('dopamine detox');
    const link = [...c.querySelectorAll('a')]
      .find((a) => a.getAttribute('href') === '/word/dopamine%20detox');
    expect(link, '卡住的词点不进去').toBeDefined();
  });

  it('给出次数和全对率——不然"卡住"只是一个形容词', async () => {
    const t = (await draw({}, stuck)).textContent ?? '';
    expect(t).toContain('54');
    expect(t, '没给全对率').toMatch(/6%|全对/);
  });

  it('排在「最常犯的错」前面——它回答的是"今天该练什么"', async () => {
    const t = (await draw({}, stuck)).textContent ?? '';
    expect(t.indexOf('卡住的词')).toBeLessThan(t.indexOf('最常犯的错'));
  });

  it('没有卡住的词就整块不出现——不显示一个空标题', async () => {
    const t = (await draw({}, [])).textContent ?? '';
    expect(t).not.toContain('卡住的词');
  });

  it('旧响应里没有 stuck 字段也不能崩', async () => {
    const t = (await draw({}, undefined)).textContent ?? '';
    expect(t).toContain('最常犯的错');
  });
});
