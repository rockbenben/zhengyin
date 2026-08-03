const VOWELS = new Set(['AA','AE','AH','AO','AW','AY','EH','ER','EY','IH','IY','OW','OY','UH','UW']);

export const IPA: Record<string, string> = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', EH: 'ɛ', ER: 'ɝ', EY: 'eɪ',
  F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p',
  R: 'r', S: 's', SH: 'ʃ', T: 't', TH: 'θ', UH: 'ʊ', UW: 'u',
  V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

export interface Phone {
  arpabet: string; base: string; ipa: string;
  stress: 0 | 1 | 2 | null; isVowel: boolean;
}

export function parsePhones(raw: string[]): Phone[] {
  return raw.map((arpabet) => {
    const m = arpabet.match(/^([A-Z]+)([012])?$/);
    if (!m) throw new Error(`bad ARPAbet phone: ${arpabet}`);
    const base = m[1];
    const stress = m[2] === undefined ? null : (Number(m[2]) as 0 | 1 | 2);
    const isVowel = VOWELS.has(base);
    let ipa = IPA[base];
    if (!ipa) throw new Error(`unknown ARPAbet phone: ${base}`);
    if (base === 'AH' && stress === 0) ipa = 'ə';
    if (base === 'ER') ipa = stress === 0 ? 'ɚ' : 'ɝ';
    return { arpabet, base, ipa, stress, isVowel };
  });
}
