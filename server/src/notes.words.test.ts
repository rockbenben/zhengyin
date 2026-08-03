import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lookupWord } from './analysis/lookup.js';
import { IPA, parsePhones } from './analysis/phones.js';

/**
 * 笔记里写着「词 + 音标」的地方，那个音标得是**这个工具真会拿它来评测的那一个**。
 *
 * ── 为什么值得一条校验 ──
 *
 * l-vs-n 的对比训练里排过一行 `Need /niːd/ | Lead /liːd/`。看着没毛病，但 CMUdict 里
 * `lead` 的主读音是「铅」`L EH1 D`，`L IY1 D` 只是备选条目 `lead(2)`，而 lookupWord 取
 * 主条目。后果是**照笔记念反而被判错**：把 lead 建成词条来练，工具对着 /lɛd/ 打分。
 *
 * ine 那篇的第三组（弱读的 -ine）整组写成 /ɪn/，而 CMUdict 五个词全是 AH0＝/ə/，
 * espeak 的 collapseStress 只归并 ə↔ʌ、ɚ↔ɝ，**不归并 ə↔ɪ**——同样是照笔记念就记一处错，
 * 而且跟同仓那篇「弱读音节要塌下去」（讲的正是弱化到 /ə/）自相矛盾。
 *
 * 这种错**没有任何一处会响**：笔记加载正常、音标显示正常、评测也正常跑，
 * 只是它教的和它测的不是同一个音。写笔记的人不会去翻词典有没有第二条读音。
 *
 * ── 三条硬约束，缺一个就会误报 ──
 *
 * 笔记里长得像「词 /斜杠内容/」的东西远不止音标，第一版逐个踩过：
 *   1. **词和斜杠之间必须有且只有一个空格**——否则 `server/src/`、拼音 `sh/zh/ch`
 *      都会被读成「某个词的音标」。
 *   2. **前面不能贴着字母或撇号**——否则 `o'clock /əˈklɑk/` 会被抠出个 `clock`，
 *      拿 o'clock 的音标去对 clock。
 *   3. **斜杠里每个字符都得是真音素或重音/长度符号**——否则 `POST /api/` 里的 `api`
 *      也算数（`a` 根本不是这套表里的音素）。
 *
 * 三条都是形状约束，不是"看着像不像"，所以不会随笔记内容漂。
 */

const NOTES = join(import.meta.dirname, '..', '..', 'notes');

/**
 * 归一到可比的形式。
 *
 * `ər` ↔ `ɚ` 是**唯一**放行的等价，而且有名有姓：CMUdict 把 marine 记成
 * `M ER0 IY1 N`（一个 r 色化元音），标准词典写 /məˈriːn/（ə 加 r），
 * 同一个音的两种记法。长度符号 `ː` 同理——笔记按词典写 /niːd/，应用显示 /nid/。
 * 不放行别的：多一条模糊等价，这条校验就少一分可信。
 */
const norm = (s: string) => s
  .replace(/[ˈˌː.‿\s]/g, '')
  .replace(/ər/g, 'ɚ')
  .replace(/ɜr/g, 'ɝ');

/**
 * 音素全集。**不能写成 `Object.values(IPA)`**——那样会漏掉 parsePhones 按重音改写出来的
 * `ə` 和 `ɚ`，而 schwa 是英语里最常见的元音：漏掉它，凡是带弱读音节的转写都会被
 * 下面那个 looksPhonetic 判成"不是音标"而**静默跳过**，这条校验就只剩个空壳。
 * （真发生过：第一版这么写，五个该报的 -ine 词只报出四个，含 ə 的那个 medicine 没了声。
 * espeak.test.ts 顶上就贴着同一条告示，同一个坑这个仓库踩过两次。）
 */
const SYMBOLS = new Set<string>(
  parsePhones(Object.keys(IPA).flatMap((b) => [0, 1, 2].map((st) => `${b}${st}`))).map((p) => p.ipa),
);

/** 这串东西整体看得出是音标吗——每个字符要么是真音素，要么是重音/长度符号 */
function looksPhonetic(s: string): boolean {
  for (const ch of s) {
    if ('ˈˌː.‿'.includes(ch)) continue;
    if (!SYMBOLS.has(ch)) return false;
  }
  return s.length > 0;
}

function pairsIn(md: string): Array<{ word: string; ipa: string }> {
  const out: Array<{ word: string; ipa: string }> = [];
  for (const m of md.replace(/\*\*/g, '').matchAll(/(?<![\w'’])([a-zA-Z]{2,15}) \/([^/\s\n|]{2,30})\//g)) {
    if (!looksPhonetic(m[2])) continue;
    out.push({ word: m[1].toLowerCase(), ipa: norm(m[2]) });
  }
  return out;
}

describe('笔记里的例词音标，跟工具实际会评测的读音一致', () => {
  const files = readdirSync(NOTES).filter((f) => f.endsWith('.md'));

  it('前提：真的读到笔记了', () => {
    expect(files.length, '一篇笔记都没读到，这条用例是空过的').toBeGreaterThanOrEqual(5);
  });

  it('每个例词的音标都跟词典一致', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      for (const { word, ipa } of pairsIn(readFileSync(join(NOTES, f), 'utf8'))) {
        const ph = lookupWord(word);
        if (!ph) continue;               // 词典查不到的词（专名、缩写）不在这条的管辖内
        checked += 1;
        const dict = norm(ph.map((p) => p.ipa).join(''));
        if (dict !== ipa) {
          bad.push(`${f}: ${word} 笔记写 /${ipa}/，工具会按 /${dict}/ 评测——照笔记念要判错`);
        }
      }
    }
    // 抽不出配对就等于空过。真实数量在一百上下，取个远低于它的下限。
    expect(checked, '一处「词 + 音标」都没抽到，这条用例是空过的').toBeGreaterThan(40);
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
  });
});
