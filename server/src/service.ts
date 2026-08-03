import { tokenize, lookupWord } from './analysis/lookup.js';
import { syllabify, toIpa } from './analysis/syllables.js';
import { extractTags, attributeTags } from './analysis/features.js';
import type { WordAnalysis } from './db.js';

export function analyzeText(text: string, ipaOverride?: string): WordAnalysis[] {
  const words = tokenize(text);
  return words.map((word) => {
    const phones = lookupWord(word);
    if (!phones) {
      return {
        word, found: false, arpabet: [],
        ipa: words.length === 1 && ipaOverride ? ipaOverride : '',
        tags: [], phoneIpa: [], phoneTags: [], syllables: [], syllableStress: [],
      };
    }
    const sylls = syllabify(phones);
    const perPhone = attributeTags(phones, sylls);
    return {
      word, found: true,
      arpabet: phones.map((p) => p.arpabet),
      ipa: toIpa(phones, sylls),
      tags: extractTags(phones, sylls),
      phoneIpa: perPhone.map((p) => p.ipa),
      phoneTags: perPhone.map((p) => p.tags),
      // 音节分组按 onset + nucleus + coda 拼回下标序列。给前端把音素格按音节分开用——
      // 这样页头的 /ˈdoʊpəˌmin/ 和下面那排格子能对上，重音落在哪一节也看得见。
      syllables: sylls.map((s) => [...s.onset, s.nucleus, ...s.coda]),
      // 逐音节的重音级别（1 主重音 / 2 次重音 / 0 轻读）。
      // **不能压成"主重音在第几节"一个下标**：那样"其余都是轻读"就成了默认结论，
      // 而 dopamine 是 1-0-2——词尾 -mine 是次重音、满元音 /miːn/，把它画成轻读是句假话。
      syllableStress: sylls.map((s) => phones[s.nucleus].stress ?? 0),
    };
  });
}
