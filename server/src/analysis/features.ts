import type { Phone } from './phones.js';
import type { Syllable } from './syllables.js';
import { isVoicedObstruent } from './articulation.js';

// 每个音素在标签抽取里各自贡献了哪些 tag——是 extractTags() 拍平输出之前的中间结果，
// 保留「这个 tag 是哪个音素位置产生的」这个信息。存在的理由：音素条要把红点/点击
// 精确挂到某一个具体的音素胶囊上（而不是笼统标红整个词），这个归属关系只有在这一趟
// 遍历里才知道，extractTags() 拍平成 Set 之后就永久丢失了。
//
// extractTags() 就是把这里每个音素的 tags 取并集——两者共用这同一趟遍历得出的结果，
// 不是两份分别维护、可能失步的逻辑。谁要改标签抽取规则，只用改这一个函数。
export interface PhoneAttribution {
  ipa: string;
  tags: string[];
}

export function attributeTags(phones: Phone[], syllables: Syllable[]): PhoneAttribution[] {
  const result: PhoneAttribution[] = phones.map((p) => ({ ipa: p.ipa, tags: [`phoneme:${p.ipa}`] }));

  for (const syl of syllables) {
    if (syl.onset.length >= 2) {
      const tag = `cluster-onset:${syl.onset.map((i) => phones[i].ipa).join('')}`;
      for (const i of syl.onset) result[i].tags.push(tag);
    }
    // 音节**尾**的辅音连缀。跟 onset 对称，但补得晚——原来只有 onset 有标签，
    // 于是讲词尾连缀的笔记没有任何办法声明自己的适用范围，只能退回按词挂
    // （detox 那篇就是这样，box / six / fix 一个都挂不上）。
    //
    // 而「音节结尾的辅音」恰恰是中文母语者的**第一号短板**（美音要点 第 1 条，
    // 按影响听懂的程度排在最前）：中文音节只能以元音 / n / ng 收尾，所以 desk 念成
    // 「代斯」、box 念成「巴克斯」。词首连缀挂得上笔记、词尾挂不上，这个不对称没有道理。
    if (syl.coda.length >= 2) {
      const tag = `cluster-coda:${syl.coda.map((i) => phones[i].ipa).join('')}`;
      for (const i of syl.coda) result[i].tags.push(tag);
    }
    for (const i of syl.onset) if (phones[i].base === 'L') result[i].tags.push('clear-l');
    for (const i of syl.coda) if (phones[i].base === 'L') result[i].tags.push('dark-l');
  }

  for (let i = 1; i < phones.length - 1; i++) {
    if (
      phones[i].base === 'T' &&
      phones[i - 1].isVowel &&
      phones[i + 1].isVowel &&
      phones[i + 1].stress === 0
    ) {
      result[i].tags.push('flap-t');
    }
  }

  // 词尾的浊辅音。中文音节收不了浊辅音（只能以元音 / n / ng 收尾），所以
  // bed→bet、dog→dock、have→half——清化之后变成另一个词。
  //
  // 这是「音节结尾的辅音」（美音要点 第 1 条）的**另一半**：
  // cluster-coda 管"两个辅音都要发出来"，这条管"最后那个不许把喉咙关掉"。
  //
  // **叫 final- 不叫 coda-**：这个仓库里 coda 指音节尾，而清化是**词尾**的事
  // （bed / bet 那个对立在词尾）。名字得对得上范围。
  //
  // 只标浊阻塞音，判据在 articulation.ts 的 isVoicedObstruent——清浊和发音方式是
  // 那张表的知识，不在这儿抄第二份。浊的鼻音流音（m n ŋ l r）没有清化问题，
  // 标了就等于给每个以 n 结尾的词挂一篇不相干的笔记。
  const last = phones.length - 1;
  if (last >= 0 && !phones[last].isVowel && isVoicedObstruent(phones[last].ipa)) {
    result[last].tags.push('final-voiced');
  }

  return result;
}

export function extractTags(phones: Phone[], syllables: Syllable[]): string[] {
  const tags = new Set<string>();
  for (const p of attributeTags(phones, syllables)) {
    for (const t of p.tags) tags.add(t);
  }
  return [...tags];
}
