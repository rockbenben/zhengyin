import { describe, it, expect } from 'vitest';
import { parsePhones } from './phones.js';
import { syllabify, toIpa } from './syllables.js';

describe('syllabify', () => {
  it('click is one syllable with kl onset', () => {
    const p = parsePhones(['K', 'L', 'IH1', 'K']);
    const s = syllabify(p);
    expect(s).toEqual([{ onset: [0, 1], nucleus: 2, coda: [3] }]);
  });
  it('detox: D IY1 T AA0 K S → de.tox (maximal onset gives t to 2nd syllable)', () => {
    const p = parsePhones(['D', 'IY1', 'T', 'AA0', 'K', 'S']);
    expect(syllabify(p)).toEqual([
      { onset: [0], nucleus: 1, coda: [] },
      { onset: [2], nucleus: 3, coda: [4, 5] },
    ]);
  });
  it('illegal cluster split: window N D OW → n stays in coda', () => {
    // W IH1 N D OW0 → win.dow（nd 不是合法 onset，只有 d 归第二音节）
    const p = parsePhones(['W', 'IH1', 'N', 'D', 'OW0']);
    expect(syllabify(p)).toEqual([
      { onset: [0], nucleus: 1, coda: [2] },
      { onset: [3], nucleus: 4, coda: [] },
    ]);
  });
  it('regret: R IH0 G R EH1 T → mid-word ɡr stays together as 2nd syllable onset', () => {
    // R IH0 G R EH1 T → rə.ɡrɛt（ɡr 是合法 onset，G 和 R 都归第二音节 onset，不拆进前一音节 coda）
    const p = parsePhones(['R', 'IH0', 'G', 'R', 'EH1', 'T']);
    expect(syllabify(p)).toEqual([
      { onset: [0], nucleus: 1, coda: [] },
      { onset: [2, 3], nucleus: 4, coda: [5] },
    ]);
  });
});

describe('toIpa', () => {
  it('primary stress mark before syllable', () => {
    const p = parsePhones(['K', 'L', 'IH1', 'K']);
    expect(toIpa(p, syllabify(p))).toBe('ˈklɪk');
  });
  it('secondary stress uses ˌ', () => {
    const p = parsePhones(['D', 'OW1', 'P', 'AH0', 'M', 'IY2', 'N']);
    expect(toIpa(p, syllabify(p))).toBe('ˈdoʊpəˌmin');
  });
});
