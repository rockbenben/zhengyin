import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EntryDetail } from '../types';

const stub = vi.hoisted(() => ({ asked: [] as string[], fail: null as null | 'offline' | 'gone' }));

vi.mock('../api', () => ({
  isOffline: () => stub.fail === 'offline',
  api: {
    getEntry: (t: string) => {
      stub.asked.push(t);
      if (stub.fail) return Promise.reject(new Error('nope'));
      return Promise.resolve({
        text: t, createdAt: '', words: [{ word: t, found: true, arpabet: [], ipa: '', tags: [], phoneIpa: [], phoneTags: [], syllables: [], syllableStress: [] }],
        audio: [{ word: t, source: 'mw', url: `/api/audio/${t}.mp3` }], phraseAudio: null,
        notes: [], review: null,
      } as unknown as EntryDetail);
    },
    pronounceHealth: () => Promise.resolve({ ok: true, uv: true }),
    getMwKey: () => Promise.resolve({ configured: true, masked: null }),
    confusions: () => Promise.resolve({ contrasts: [] }),
    articulation: () => Promise.resolve({ places: [], manners: {}, phones: [] }),
  },
}));
vi.mock('../lib/asr', () => ({
  checkModelAvailability: () => Promise.resolve('available'),
  contrastAll: () => Promise.resolve([]),
  resetModel: () => {},
}));

const { default: DrillPhoneme } = await import('./DrillPhoneme');

/**
 * 在音素页上就地练这个音。
 *
 * ── 为什么要有 ──
 * 评测报「第 2 个音发成了 /æ/」，点那个音跳到音素页，然后只能**读**一段
 * "舌头躺平、嘴半开"。要练得记住这个音在哪些词里、回首页一个个查——
 * 而例词就在同一页上列着，隔着一次跳转。
 *
 * 守三件：挑得到词、挑了才去取音频（不预取）、一次只摆一个录音器。
 */
function draw(words = [{ text: 'about', ipa: 'əˈbaʊt' }, { text: 'machine', ipa: 'məˈʃin' }]) {
  stub.asked = [];
  stub.fail = null;
  const { container } = render(
    <MemoryRouter><DrillPhoneme ipa="ə" words={words} /></MemoryRouter>,
  );
  return container;
}

// 词名现在是链接，展开录音器的是它旁边那个「练」。按 aria-label 找，不锁按钮文字。
const pick = (c: HTMLElement, w: string) =>
  [...c.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').includes(w))!;

describe('在音素页上练这个音', () => {
  it('例词都摆出来，点得到', () => {
    const c = draw();
    expect(pick(c, 'about')).toBeDefined();
    expect(pick(c, 'machine')).toBeDefined();
  });

  it('**没点之前不去取音频**——41 个音素页各预取十几个词条，绝大多数人不会点', () => {
    draw();
    expect(stub.asked, '预取了').toEqual([]);
  });

  it('点了才取，而且只取那一个词', async () => {
    const c = draw();
    fireEvent.click(pick(c, 'machine'));
    await waitFor(() => expect(stub.asked).toEqual(['machine']));
  });

  it('一次只摆一个录音器——同时铺两个，人不知道该先念哪个', async () => {
    const c = draw();
    fireEvent.click(pick(c, 'about'));
    await waitFor(() => expect(c.textContent).toMatch(/录音/));
    fireEvent.click(pick(c, 'machine'));
    await waitFor(() => expect(stub.asked).toContain('machine'));
    const recs = [...c.querySelectorAll('button')].filter((b) => /^录音/.test(b.textContent ?? ''));
    expect(recs.length).toBeLessThanOrEqual(1);
  });

  it('再点一次收起来', async () => {
    const c = draw();
    fireEvent.click(pick(c, 'about'));
    await waitFor(() => expect(c.textContent).toMatch(/录音/));
    fireEvent.click(pick(c, 'about'));
    await waitFor(() => expect(c.textContent).not.toMatch(/录音/));
  });

  /**
   * 「库里含这个音的词」和「挑一个练」一度是两块，而它们渲染的是同一个 examples
   * 数组——同样的词、同样的顺序，在一屏里叠了两遍（/n/ 有 9 个例词时尤其刺眼）。
   * 现在合成一块：词名是链接，旁边一个「练」就地展开录音器。
   */
  it('每个词只列一次，不是一份链接再一份按钮', () => {
    const c = draw();
    const times = (c.textContent ?? '').split('machine').length - 1;
    expect(times, '「machine」在一屏里出现了不止一次').toBe(1);
  });

  it('词名点得进它自己的词条页——合并之后这条路不能丢', () => {
    const c = draw();
    const hrefs = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/word/machine');
  });

  it('库里没有含这个音的词 → 整块不出现', () => {
    expect(draw([]).textContent).toBe('');
  });

  it('词条取不到时说清楚，而不是空白一片', async () => {
    const c = draw();
    stub.fail = 'gone';
    fireEvent.click(pick(c, 'about'));
    await waitFor(() => expect(c.textContent).toMatch(/取不到|换一个/));
  });
});
