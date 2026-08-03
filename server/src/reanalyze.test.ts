import { describe, it, expect } from 'vitest';
import { openDb, upsertEntry, getEntry, listEntries } from './db.js';
import { analyzeText } from './service.js';
import { reanalyzeEntries } from './reanalyze.js';

/**
 * 词条的推导结果（音素、音节、标签）是**入库那一刻算好存进 words_json 的**。
 * 于是给分析器加一条新规则，对已有词条一个都不生效——实测 `judge` /dʒʌdʒ/
 * 以浊塞擦音收尾，本该有 `final-voiced`，而它是那个标签出现之前入库的，
 * 那篇讲词尾浊辅音的笔记永远不会出现在它上面。
 *
 * 而**不能无脑全重算**：ipaOverride（词典查不到的词手工给的音标）没有单独存，
 * 它就写在 words_json 里那个 `found: false` 的词的 ipa 字段上。
 * 重算时 analyzeText 拿不到 override，会把它算成空串——手工音标当场丢掉。
 */
function db() {
  return openDb(':memory:');
}

/** 造一个"旧格式"的词条：推导结果是手写的旧值 */
function stale(d: ReturnType<typeof db>, text: string, words: unknown) {
  upsertEntry(d, text, words as never, '2026-07-29T00:00:00Z');
}

describe('按当前规则重算已有词条', () => {
  it('旧词条缺了后加的标签 → 补上', () => {
    const d = db();
    // judge /dʒʌdʒ/：真实推导有 final-voiced，这里存一份没有它的旧结果
    const now = analyzeText('judge');
    const old = now.map((w) => ({ ...w, tags: w.tags.filter((t) => t !== 'final-voiced') }));
    expect(old[0].tags, '前提：造出来的旧结果确实没有那个标签').not.toContain('final-voiced');
    stale(d, 'judge', old);

    const r = reanalyzeEntries(d);
    expect(r.refreshed).toEqual(['judge']);
    expect(getEntry(d, 'judge')!.words[0].tags, '重算之后还是没有').toContain('final-voiced');
  });

  it('已经是最新的 → 一个都不写，不白改库', () => {
    const d = db();
    upsertEntry(d, 'judge', analyzeText('judge'), '2026-07-29T00:00:00Z');
    expect(reanalyzeEntries(d).refreshed).toEqual([]);
  });

  // 这一条是这个模块存在的全部风险所在
  it('词典里查不到的词 → 一个字都不碰，手工音标必须还在', () => {
    const d = db();
    const words = analyzeText('anthropic', '/ænˈθrɑpɪk/');
    expect(words[0].found, '前提：这个词确实不在 CMUdict 里').toBe(false);
    expect(words[0].ipa, '前提：手工音标存进去了').toBe('/ænˈθrɑpɪk/');
    upsertEntry(d, 'anthropic', words, '2026-07-29T00:00:00Z');

    const r = reanalyzeEntries(d);
    expect(r.refreshed, '把带手工音标的词条重算了').toEqual([]);
    expect(getEntry(d, 'anthropic')!.words[0].ipa, '手工音标被冲掉了').toBe('/ænˈθrɑpɪk/');
  });

  it('短语里只要有一个词查不到，整条都不碰', () => {
    const d = db();
    const words = analyzeText('anthropic click');
    expect(words.some((w) => !w.found), '前提：至少一个词查不到').toBe(true);
    upsertEntry(d, 'anthropic click', words, '2026-07-29T00:00:00Z');
    expect(reanalyzeEntries(d).refreshed).toEqual([]);
  });

  // 界面上那一列叫「更新时间」，用户读作"我上次动这个词是什么时候"。
  // 一次重算把所有词条推到今天，等于在屏幕上说了句假话。
  it('重算不动更新时间', () => {
    const d = db();
    const now = analyzeText('judge');
    stale(d, 'judge', now.map((w) => ({ ...w, tags: [] })));
    const before = getEntry(d, 'judge')!.updatedAt;

    reanalyzeEntries(d);
    expect(getEntry(d, 'judge')!.updatedAt, '更新时间被推到今天了').toBe(before);
  });

  it('checked 报的是看过几个，refreshed 报的是真改了哪几个', () => {
    const d = db();
    upsertEntry(d, 'judge', analyzeText('judge').map((w) => ({ ...w, tags: [] })), '2026-07-29T00:00:00Z');
    upsertEntry(d, 'click', analyzeText('click'), '2026-07-29T00:00:00Z');
    const r = reanalyzeEntries(d);
    expect(r.checked).toBe(listEntries(d).length);
    expect(r.refreshed).toEqual(['judge']);
  });
});
