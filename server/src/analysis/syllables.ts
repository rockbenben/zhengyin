import type { Phone } from './phones.js';

// 英语合法 onset（按 IPA 串），用于 Maximal Onset 归属判断
export const LEGAL_ONSETS = new Set([
  'pl','pr','bl','br','tr','dr','kl','kr','ɡl','ɡr','fl','fr',
  'sl','sm','sn','sp','st','sk','sw','sf','tw','dw','kw','ɡw',
  'θr','θw','ʃr','pj','bj','tj','dj','kj','ɡj','mj','nj','fj','vj','hj','lj','sj',
  'spl','spr','str','skr','skw','spj','stj','skj',
]);

export interface Syllable { onset: number[]; nucleus: number; coda: number[] }

export function syllabify(phones: Phone[]): Syllable[] {
  const nuclei = phones.map((p, i) => (p.isVowel ? i : -1)).filter((i) => i >= 0);
  if (nuclei.length === 0) return [];
  const sylls: Syllable[] = nuclei.map((n) => ({ onset: [], nucleus: n, coda: [] }));
  // 词首辅音全归第一音节 onset
  sylls[0].onset = range(0, nuclei[0]);
  // 词尾辅音全归最后音节 coda
  sylls[sylls.length - 1].coda = range(nuclei[nuclei.length - 1] + 1, phones.length);
  // 中间辅音段：从后往前找最长合法 onset，其余进前一音节 coda
  for (let s = 0; s < sylls.length - 1; s++) {
    const between = range(nuclei[s] + 1, nuclei[s + 1]);
    let split = 0; // between[split..] 归下一音节 onset
    for (let k = 0; k <= between.length; k++) {
      const cand = between.slice(k).map((i) => phones[i].ipa).join('');
      if (cand === '' || between.length - k === 1 || LEGAL_ONSETS.has(cand)) { split = k; break; }
    }
    sylls[s].coda = between.slice(0, split);
    sylls[s + 1].onset = between.slice(split);
  }
  return sylls;
}

export function toIpa(phones: Phone[], syllables: Syllable[]): string {
  let out = '';
  for (const syl of syllables) {
    const stress = phones[syl.nucleus].stress;
    if (stress === 1) out += 'ˈ';
    if (stress === 2) out += 'ˌ';
    for (const i of [...syl.onset, syl.nucleus, ...syl.coda]) out += phones[i].ipa;
  }
  return out || phones.map((p) => p.ipa).join('');
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a }, (_, i) => a + i);
}
