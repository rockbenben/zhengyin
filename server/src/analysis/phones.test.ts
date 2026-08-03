import { describe, it, expect } from 'vitest';
import { parsePhones } from './phones.js';

describe('parsePhones', () => {
  it('parses CLICK = K L IH1 K', () => {
    const p = parsePhones(['K', 'L', 'IH1', 'K']);
    expect(p.map((x) => x.ipa)).toEqual(['k', 'l', 'ɪ', 'k']);
    expect(p[2]).toMatchObject({ base: 'IH', stress: 1, isVowel: true });
    expect(p[0]).toMatchObject({ stress: null, isVowel: false });
  });
  it('AH0 reduces to schwa, AH1 is wedge', () => {
    expect(parsePhones(['AH0'])[0].ipa).toBe('ə');
    expect(parsePhones(['AH1'])[0].ipa).toBe('ʌ');
  });
  it('ER stressed vs unstressed', () => {
    expect(parsePhones(['ER1'])[0].ipa).toBe('ɝ');
    expect(parsePhones(['ER0'])[0].ipa).toBe('ɚ');
  });
  it('affricates and digraphs', () => {
    expect(parsePhones(['CH', 'JH', 'SH', 'ZH', 'TH', 'DH', 'NG']).map((x) => x.ipa))
      .toEqual(['tʃ', 'dʒ', 'ʃ', 'ʒ', 'θ', 'ð', 'ŋ']);
  });
});
