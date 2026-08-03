import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { StatsResult } from '../types';

const stub = vi.hoisted(() => ({ stats: null as StatsResult | null }));
vi.mock('../api', () => ({ api: { stats: () => Promise.resolve(stub.stats) } }));

const { default: TodayPlan } = await import('./TodayPlan');

/**
 * 「卡住的地方」。
 *
 * 这一块存在的理由是：答案原来埋在统计页里——卡住的词和反复出错却没讲解的音，
 * 一个只用网页的人得自己翻进去拼出结论，多数人不会拼。
 * **到期复习不在这儿**：侧栏角标翻到哪一页都在，这儿再说一遍只是重复。
 *
 * 断言不锁文案，锁的是：**每样数据都给得出一个能点的动作**、
 * **没事做的时候整块消失**（空的待办列表比没有列表更让人泄气），
 * 以及**它不许长到铺满一屏**——满屏都是「你卡住了」等于什么都没说。
 */
function stats(over: Partial<StatsResult> = {}): StatsResult {
  return {
    overall: { attempts: 10, clean: 1, words: 3, firstAt: null, lastAt: null },
    stuck: [],
    phonemes: [],
    ...over,
  };
}

async function draw(over: Partial<StatsResult> = {}) {
  stub.stats = stats(over);
  const { container } = render(<MemoryRouter><TodayPlan /></MemoryRouter>);
  // 有内容时等它渲染出来；没内容的用例靠下面的显式断言
  await waitFor(() => expect(container).toBeTruthy());
  return container;
}

const STUCK = [{ text: 'dopamine detox', attempts: 54, clean: 3 }];
const NEED_NOTE = [{
  kind: 'del' as const, targetIpa: 'k', heardIpa: null, count: 4, lastAt: '',
  words: ['a', 'b'], notes: [], worthANote: true,
}] as StatsResult['phonemes'];

describe('卡住的地方', () => {
  it('不管复习——到期数侧栏一直挂着，这儿再说一遍只是重复', async () => {
    const c = await draw({ stuck: STUCK });
    await waitFor(() => expect(c.textContent).toContain('dopamine detox'));
    expect([...c.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/review')).toBe(false);
  });

  it('卡住的词直接点得进那个词', async () => {
    const c = await draw({ stuck: STUCK });
    await waitFor(() => expect(c.textContent).toContain('dopamine detox'));
    expect([...c.querySelectorAll('a')]
      .some((a) => a.getAttribute('href') === '/word/dopamine%20detox')).toBe(true);
  });

  /**
   * 这一行原来写「1 个音反复错、还没有讲解」，链到 /stats。
   * 点过去也不知道指的是哪个错误——**它不说是哪个音**，
   * 而同一块里的「卡住的词」是逐个点名、逐个能点进去的。同一块里两种待遇。
   *
   * 现在说出那处错法、链到那个音自己的页（怎么发就在那儿），并点出错在哪几个词上。
   */
  it('说出是哪个音，而不是只报一个数', async () => {
    const c = await draw({ phonemes: NEED_NOTE });
    await waitFor(() => expect(c.textContent).toMatch(/k/));
    // 那处错法要写成人话，而不是 kind=del 这种内部说法
    expect(c.textContent).toMatch(/没发出来|发成了|多发了/);
    // 出错的词也要点出来——「哪个错误」得答得上
    expect(c.textContent).toMatch(/a|b/);
  });

  it('点得进那个音自己的页——不是把人扔到统计页上自己找', async () => {
    const c = await draw({ phonemes: NEED_NOTE });
    await waitFor(() => expect(c.textContent).toMatch(/没发出来/));
    const hrefs = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.startsWith('/phoneme/')), `落点是 ${hrefs.join('、')}`).toBe(true);
  });

  it('已经有讲解的音不算待办——那不是"要做的事"', async () => {
    const withNote = [{ ...NEED_NOTE[0], notes: [{ id: 'x', title: '某篇' }] }] as StatsResult['phonemes'];
    const c = await draw({ phonemes: withNote });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.textContent).toBe('');
  });

  it('够不上门槛的音也不算——判据在服务端，前端不另立一套', async () => {
    const notWorth = [{ ...NEED_NOTE[0], worthANote: false }] as StatsResult['phonemes'];
    const c = await draw({ phonemes: notWorth });
    await new Promise((r) => setTimeout(r, 50));
    expect(c.textContent).toBe('');
  });

  it('两样都没有 → 整块不出现，不显示一个空的待办列表', async () => {
    const c = await draw();
    await new Promise((r) => setTimeout(r, 50));
    expect(c.textContent).toBe('');
  });

  /**
   * 整块最多三行。
   *
   * 音素那部分一度是"每个音一行、最多三行"，加上卡住的词那一行就是四行；
   * 练得越久这块越长，得有个上限，不能堆成一屏。
   * **满屏都是「你卡住了」等于什么都没说**——它是一句"接下来干这个"的提示，
   * 不是一份报告；报告在发音统计页。
   *
   * 另一半同样要守：**砍掉了就得说出来**。悄悄砍读起来就是"就这些了"。
   */
  const manyNotes = (n: number) => Array.from({ length: n }, (_, i) => ({
    kind: 'del', targetIpa: String.fromCharCode(107 + i), heardIpa: null,
    count: 9 - i, lastAt: '', words: ['w1', 'w2'], notes: [], worthANote: true,
  })) as unknown as StatsResult['phonemes'];

  const rowCount = (c: HTMLElement) =>
    [...c.querySelectorAll('div')].filter((d) => d.style.borderTop.includes('1px')).length;

  it('练得久了也不铺满——整块最多三行', async () => {
    const c = await draw({ stuck: [{ text: 'w', attempts: 9, clean: 1 }], phonemes: manyNotes(8) });
    await waitFor(() => expect(c.textContent).toMatch(/没发出来/));
    expect(rowCount(c), '行数失控了').toBeLessThanOrEqual(3);
  });

  it('没有卡住的词时，三行全给音素——不浪费额度', async () => {
    const c = await draw({ phonemes: manyNotes(8) });
    await waitFor(() => expect(c.textContent).toMatch(/没发出来/));
    expect(rowCount(c)).toBe(3);
  });

  it('**砍掉了要说出来**，并给得出去哪看全的', async () => {
    const c = await draw({ stuck: [{ text: 'w', attempts: 9, clean: 1 }], phonemes: manyNotes(8) });
    await waitFor(() => expect(c.textContent).toMatch(/没发出来/));
    // 8 个音里只放得下 2 个 → 剩 6
    expect(c.textContent).toMatch(/6 处/);
    expect([...c.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/stats')).toBe(true);
  });

  it('没砍就不要多那句话——没被截断时不该冒出「另外还有 0 处」', async () => {
    const c = await draw({ phonemes: manyNotes(2) });
    await waitFor(() => expect(c.textContent).toMatch(/没发出来/));
    expect(c.textContent).not.toMatch(/另外还有/);
  });

  it('卡住的词被砍掉的也算进那句话里——它本来一直在悄悄砍', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ text: `w${i}`, attempts: 9, clean: 1 }));
    const c = await draw({ stuck: many });
    await waitFor(() => expect(c.textContent).toContain('w0'));
    expect(c.textContent).toMatch(/4 处/);   // 7 个只列 3 个
  });

  it('卡住的词最多列三个——列表越长越像背景板', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ text: `w${i}`, attempts: 9, clean: 1 }));
    const c = await draw({ stuck: many });
    await waitFor(() => expect(c.textContent).toContain('w0'));
    expect(c.textContent).not.toContain('w3');
  });

  /**
   * 这一块最多三行，所以**任何一句整句都不该在两行里同时出现**。
   *
   * 踩过：音素那几行右边跟着一句「…都错在这儿；点进去看这个音怎么发」，后半截每行
   * 一模一样，而例词又常常相同（同两个词里既漏 /k/ 又漏 /p/）——三行读起来像复制粘贴。
   * 「点进去」还是在替链接说它自己已经说了的事。
   *
   * 断言**不锁具体文案**，锁的是"没有整句重复"：换了措辞照样管用。
   */
  it('三行之间不许出现一模一样的整句', async () => {
    const c = await draw({
      stuck: STUCK,
      // 两个不同的音，但例词完全相同——最容易长出重复句子的情况
      phonemes: [
        { kind: 'del', targetIpa: 'k', heardIpa: null, count: 5, lastAt: '', words: ['x y', 'p q'], notes: [], worthANote: true },
        { kind: 'del', targetIpa: 'p', heardIpa: null, count: 3, lastAt: '', words: ['x y', 'p q'], notes: [], worthANote: true },
      ] as StatsResult['phonemes'],
    });
    await waitFor(() => expect(c.textContent).toContain('x y'));

    // 按行取文本，切成句子，看有没有哪一句在两行里都出现
    const rows = [...c.querySelectorAll('section > div > div')].map((d) => d.textContent ?? '');
    expect(rows.length, '前提：真的渲染出了多行').toBeGreaterThan(1);
    const seen = new Map<string, number>();
    for (const r of rows) {
      for (const raw of r.split(/[；;。]/)) {
        const t = raw.trim();
        if (t.length < 6) continue;                   // 太短的片段（如例词本身）不算"整句"
        seen.set(t, (seen.get(t) ?? 0) + 1);
      }
    }
    const dup = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
    expect(dup, `这几句在多行里重复出现，整块读起来像复制粘贴：${dup.join(' / ')}`).toEqual([]);
  });
});
