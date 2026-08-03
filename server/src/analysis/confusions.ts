import { dictionary } from 'cmu-pronouncing-dictionary';
import { IPA } from './phones.js';
import { lookupWord } from './lookup.js';
import type { Note } from '../notes.js';

// IPA → ARPAbet base 的反向表，从 phones.ts 的 IPA 表推出来，不重复维护一份。
// notes.ts 的 VALID_PHONEMES 已经保证任何真正被笔记引用的 phoneme:<ipa> trigger
// 都在 Object.values(IPA) 里，所以这张反向表覆盖得到任何合法笔记声明的音素。
const BASE_OF_IPA: Record<string, string> = Object.fromEntries(
  Object.entries(IPA).map(([base, ipa]) => [ipa, base]),
);

// 同一篇笔记内一起声明的 phoneme:<ipa> trigger 互相视为"容易混淆"——l-vs-n 笔记
// 的 triggers: [phoneme:l, phoneme:n] 就意味着 l 和 n 互相混淆。这个集合完全由
// 笔记内容推出来，不写死任何具体音素对：笔记加得越多，这个功能覆盖的混淆就越多，
// 不用改代码（这是整个项目的设计原则——笔记是唯一的知识来源）。
export function confusableSets(notes: Note[]): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const note of notes) {
    const ipas = note.triggers
      .map((t) => t.match(/^phoneme:(.+)$/)?.[1])
      .filter((x): x is string => Boolean(x));
    for (const a of ipas) {
      for (const b of ipas) {
        if (a === b) continue;
        if (!sets.has(a)) sets.set(a, new Set());
        sets.get(a)!.add(b);
      }
    }
  }
  return sets;
}

// 音素序列（cmudict 原始 "L AY1 T" 格式字符串）→ 词。懒加载：首次用到才扫一遍
// 完整的 13.5 万词典并建反向索引，建好后缓存在模块作用域，不在导入时就建（避免
// 拖慢服务启动），也不每次请求都重扫。
let reverseIndexCache: Map<string, string[]> | null = null;
function reverseIndex(): Map<string, string[]> {
  if (!reverseIndexCache) {
    const index = new Map<string, string[]>();
    for (const [rawWord, raw] of Object.entries(dictionary)) {
      const word = rawWord.replace(/\(\d+\)$/, '');
      // 只留纯字母词：cmudict 里还有 "'til"/"a.m."/数字缩写这类条目，拿来给识别
      // 语法当候选词没有意义。
      if (!/^[a-z]+$/.test(word)) continue;
      const phones = raw.split('#')[0].trim();
      const words = index.get(phones);
      if (words) { if (!words.includes(word)) words.push(word); }
      else index.set(phones, [word]);
    }
    reverseIndexCache = index;
  }
  return reverseIndexCache;
}

/** 一个跟 target 只差一个音素的真实词，以及差在哪。怎么找出来的见 confusionContrasts。 */
export interface Contrast {
  /** 跟 target 只差一个音素的真实英文词 */
  word: string;
  /** 差在第几个音素（target 音素序列里的下标，0 起） */
  index: number;
  /** target 在这个位置的音素 */
  targetIpa: string;
  /** 候选词在这个位置的音素 */
  partnerIpa: string;
}

/**
 * target 的每个音素位置，只要它的 IPA 落在笔记推出的混淆集合里，就依次换成集合里
 * 每个搭档音素、拼出新的 ARPAbet 序列去反查词典——只返回词典里真实存在的词，不
 * 臆造拼写。这就是为什么 need→lead 这种非词首、且元音也不同的替换能被找到：
 * N IY1 D 换成 L IY1 D 是在音素层面做的，不是在字母拼写上加减字符。
 *
 * 返回的每一项都带着**替换发生在哪个位置**——这正是"音素级"判定的依据：拿 target 和
 * 某个 Contrast 做一次二选一，赢谁就等于回答了"你第 index 个音发的是 targetIpa 还是
 * partnerIpa"。早先的版本把这个下标丢了、只返回词表，于是评测只能给出整词层面的
 * 结论，说不出错在哪个音。
 *
 * 每个位置最多留一个搭档词：同一位置有多个同音异形词（如 L IY1 D 同时映射 lead/leed）
 * 时，二选一测试里放哪个都一样，多放只是让下游多跑几次识别。
 */
export function confusionContrasts(target: string, notes: Note[], max = 8): Contrast[] {
  const phones = lookupWord(target);
  if (!phones) return [];
  const sets = confusableSets(notes);
  const index = reverseIndex();
  const seen = new Set([target.trim().toLowerCase()]);
  const out: Contrast[] = [];

  for (let i = 0; i < phones.length && out.length < max; i++) {
    const partners = sets.get(phones[i].ipa);
    if (!partners) continue;
    const stress = phones[i].stress;
    for (const partnerIpa of partners) {
      const partnerBase = BASE_OF_IPA[partnerIpa];
      if (!partnerBase) continue;
      const candidateArpabet = phones
        .map((p, j) => (j === i ? partnerBase + (stress ?? '') : p.arpabet))
        .join(' ');
      const word = (index.get(candidateArpabet) ?? []).find((w) => !seen.has(w));
      if (!word) continue;
      seen.add(word);
      out.push({ word, index: i, targetIpa: phones[i].ipa, partnerIpa });
      if (out.length >= max) break;
    }
  }
  return out;
}
