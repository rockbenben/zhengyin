import type Database from 'better-sqlite3';
import { listEntries, refreshWords } from './db.js';
import { analyzeText } from './service.js';

/**
 * 把库里已有词条的**推导结果**按当前规则重算一遍。
 *
 * ── 为什么需要 ──
 *
 * 词条的分析结果（音素、音节、标签）是**入库那一刻算好存进 words_json 的**，
 * 之后再没人碰。于是给分析器加一条新规则，对已有词条一个都不生效：
 * 实测 `judge` /dʒʌdʒ/ 以浊塞擦音收尾，本该有 `final-voiced` 标签，
 * 而它是 7-29 入库的，那个标签是 8-02 才加的——那篇讲词尾浊辅音的笔记
 * 永远不会出现在它上面。
 *
 * 音素类标签不受影响（`phoneme:<ipa>` 每个音都有，一直都在），
 * 受影响的只有**后加的结构标签**。但那正是最难自己发现的一类。
 *
 * ── 为什么不能无脑全重算 ──
 *
 * `ipaOverride`（CMUdict 查不到的词手工给的音标）**没有单独存**——
 * 它被写进 `words_json` 里那个词的 `ipa` 字段，而那个词是 `found: false`。
 * 重算时 analyzeText 拿不到 override，会把它算成空字符串，手工音标当场丢掉。
 *
 * 所以判据是：**只重算「每个词都在词典里」的词条**。那种词条的推导 100% 来自
 * CMUdict + 规则，是可再生的；只要有一个词 `found: false`，就可能带着手工音标，
 * 一律不碰。
 *
 * ── 为什么不动 updated_at ──
 *
 * 界面上那一列叫「更新时间」，用户读作"我上次动这个词是什么时候"。
 * 一次重算把 46 个词条的时间全推到今天，等于在屏幕上说了句假话。
 * 推导结果变了、而人没做任何事——这种更新不该出现在那一列里。
 */
export function reanalyzeEntries(db: Database.Database): { checked: number; refreshed: string[] } {
  const rows = listEntries(db);
  const refreshed: string[] = [];
  for (const row of rows) {
    // 有任何一个词不在词典里 → 可能带着手工音标，不碰
    if (row.words.some((w) => !w.found)) continue;
    const next = analyzeText(row.text);
    if (next.some((w) => !w.found)) continue;          // 词典这次查不到了？同样不碰
    // 只在真的变了才写。没变还写的话，每次启动都白白改一遍库
    if (JSON.stringify(next) === JSON.stringify(row.words)) continue;
    refreshWords(db, row.text, next);
    refreshed.push(row.text);
  }
  return { checked: rows.length, refreshed };
}
