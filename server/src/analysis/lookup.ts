import { dictionary } from 'cmu-pronouncing-dictionary';
import { parsePhones, type Phone } from './phones.js';

export function tokenize(text: string): string[] {
  return text.split(/[\s-]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/**
 * CMUdict 的错条修正。
 *
 * CMUdict 是个固定依赖，里面确实有错条。错条的后果不只是音标显示错——**你念对了，评测
 * 会报你发错**，然后据此建复习卡、往发音档案里写一条根本不存在的短板。而档案是这个仓库
 * 里除笔记之外唯一不可再生的东西。所以错条必须在词典入口就改掉，不能只在界面上打补丁。
 *
 * 加条目的规矩：**得能证明它错**，不能凭印象。下面每一条都注明了证据。
 * 用 Map 而不是对象字面量：对象字面量带着 Object.prototype，CORRECTIONS['constructor']
 * 会拿到 Function 构造器（真值、非 null），于是 `?? dictionary[key]` 永远轮不到，
 * 「constructor」这个真词就查不到了。这正是下面 dictionary 那段注释警告过的同一个坑。
 */
const CORRECTIONS = new Map<string, string>([
  // CMUdict: D AA1 P AH0 M AY2 N（"DAH-puh-mine"）。两处都错，而且用词典自己的数据就能证：
  //   · 词尾：-amine 这一族在 CMUdict 里全是 M IY2 N —— histamine / amphetamine /
  //     melamine 都是，amine 本身是 M IY1 N。只有 dopamine 是 M AY2 N，是唯一的例外。
  //   · 首元音：词干 dopa 是 D OW1 P AH0、dope 是 D OW1 P。dopamine 却写成 D AA1 P，
  //     跟自己的词干不一致。
  // 正确读法 /ˈdoʊpəˌmiːn/（DOH-puh-meen），Merriam-Webster 亦作 \ˈdō-pə-ˌmēn\。
  ['dopamine', 'D OW1 P AH0 M IY2 N'],
]);

export function lookupWord(word: string): Phone[] | null {
  // dictionary 是第三方包导出的普通对象，带着 Object.prototype。查 "__proto__" 拿到的是
  // Object.prototype 本身（对象，真值），后面 raw.split 会直接 TypeError 冲出 Hono handler，
  // 让 POST /api/entries {"text":"__proto__"} 变成 500。所以不能只判真值，必须确认拿到的
  // 确实是词典里的一条字符串音标。
  // 注意：修好之后这类词走的是正常的"词典里没有"分支（found:false），请求 200、照常建词条，
  // 并不会被拦成 400——服务端目前没有"词必须在词典里"这道校验。
  const key = word.toLowerCase();
  // 修正表优先。放在词典查询之前而不是之后，是因为它要覆盖的正是"词典里有、但写错了"
  // 的情况——放后面的话永远轮不到它。
  const raw: unknown = CORRECTIONS.get(key) ?? dictionary[key];
  if (typeof raw !== 'string') return null;
  const phones = raw.split('#')[0].trim().split(' ');
  return parsePhones(phones);
}
