import { describe, it, expect } from 'vitest';
import { openDb, logAttempt, putAttribution, noteEvidence } from './db.js';
import { reconcileAttempts, attributionOf } from './reconcile.js';
import type { Note } from './notes.js';

/**
 * `attempt_note` 是**缓存**：内容完全由（错误行 + 这次念的词 + 当前的 notes/）派生。
 * 这一组守的就是这句话——规则一改，历史归属自己跟上，不用写迁移、不用跑脚本。
 *
 * 它替掉的是一个真实的坑：这张表原来是流水，判据改过三轮之后，库里 182 条证据
 * 有 39 条站不住，而界面上「录音里反复出现」数的就是它。
 */
function note(over: Partial<Note>): Note {
  return {
    id: 'n', title: 't', triggers: [], contrasts: [], words: [],
    severity: 'info', markdown: '', file: 'n.md', ...over,
  };
}

const LVN = note({ id: 'l-vs-n', triggers: ['phoneme:l', 'phoneme:n'] });
const NVNG = note({ id: 'n-vs-ng', triggers: ['phoneme:n', 'phoneme:ŋ'] });
const KL = note({ id: 'kl-cluster', triggers: ['cluster-onset:kl'] });
const INE = note({ id: 'ine-spelling', words: ['machine'] });

/** 记一次录音：thin /θ ɪ n/ 念成了 /θ ɪ ŋ/（第 3 个音，下标 2） */
function nToNg(db: ReturnType<typeof openDb>, at = '2026-08-02T00:00:00Z') {
  return logAttempt(db, {
    entryText: 'thin', target: 'thin', at,
    targetIpa: ['θ', 'ɪ', 'n'], heardIpa: ['θ', 'ɪ', 'ŋ'],
    ops: [
      { kind: 'match', targetIpa: 'θ', heardIpa: 'θ' },
      { kind: 'match', targetIpa: 'ɪ', heardIpa: 'ɪ' },
      { kind: 'sub', targetIpa: 'n', heardIpa: 'ŋ' },
    ],
    clean: false,
  });
}

describe('笔记归属是算出来的，不是存下来的', () => {
  it('库里存着按老规矩记的归属 → 按当前规则改回来', () => {
    const db = openDb(':memory:');
    const id = nToNg(db);
    // 老版本：n→ŋ 被只讲 l/n 的那篇冒领了（bestExplainers 当时只要沾上一边）
    putAttribution(db, id, ['l-vs-n']);

    const r = reconcileAttempts(db, [LVN, NVNG]);
    expect(r.changed).toEqual([{
      target: 'thin', at: '2026-08-02T00:00:00Z', added: ['n-vs-ng'], removed: ['l-vs-n'],
    }]);
    expect([...noteEvidence(db).keys()]).toEqual(['n-vs-ng']);
  });

  it('已经对了就一条都不写——不然每次启动白改一遍库', () => {
    const db = openDb(':memory:');
    putAttribution(db, nToNg(db), ['n-vs-ng']);
    const r = reconcileAttempts(db, [LVN, NVNG]);
    expect(r.changed).toEqual([]);
    expect(r.checked).toBe(1);
  });

  /**
   * 这一条是加 at_index 那一列的全部理由。结构类笔记（辅音连缀、clear-l/dark-l、
   * flap-t、词尾浊辅音）按**位置**算范围，光看音素反推不出来——
   * click 加塞的那个 /ə/ 夹在 k 和 l 中间，它自己在目标序列上没有位置。
   */
  it('多出来的音：结构标签取夹缝两边，不是只看一边', () => {
    const db = openDb(':memory:');
    // click /k l ɪ k/ 念成 /k ə l ɪ k/：ə 插在下标 1 之前
    logAttempt(db, {
      entryText: 'click', target: 'click', at: '2026-08-02T00:00:00Z',
      targetIpa: ['k', 'l', 'ɪ', 'k'], heardIpa: ['k', 'ə', 'l', 'ɪ', 'k'],
      ops: [
        { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
        { kind: 'ins', heardIpa: 'ə' },
        { kind: 'match', targetIpa: 'l', heardIpa: 'l' },
        { kind: 'match', targetIpa: 'ɪ', heardIpa: 'ɪ' },
        { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
      ],
      clean: false,
    });
    reconcileAttempts(db, [KL]);
    expect([...noteEvidence(db).keys()], '连缀的笔记在它讲的那处错上没挂上').toEqual(['kl-cluster']);
  });

  /**
   * 上面那条**分不出对错**——click 的 `cluster-onset:kl` 同时挂在 k 和 l 上，
   * 只看右边一格也能沾到，把"取夹缝两边"改成"只看右边"照样绿。变异测试活下来才发现。
   *
   * desk 词尾加个元音（des-k-uh，中文母语者的典型加塞）就分得出来：
   * `cluster-coda:sk` 挂在 s 和 k 上，而插入点在 k **之后**，右边一格什么都没有。
   */
  it('多出来的音落在词尾：左边那格的结构标签也要算', () => {
    const db = openDb(':memory:');
    const coda = note({ id: 'coda-cluster', triggers: ['cluster-coda:sk'] });
    logAttempt(db, {
      entryText: 'desk', target: 'desk', at: '2026-08-02T00:00:00Z',
      targetIpa: ['d', 'ɛ', 's', 'k'], heardIpa: ['d', 'ɛ', 's', 'k', 'ə'],
      ops: [
        { kind: 'match', targetIpa: 'd', heardIpa: 'd' },
        { kind: 'match', targetIpa: 'ɛ', heardIpa: 'ɛ' },
        { kind: 'match', targetIpa: 's', heardIpa: 's' },
        { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
        { kind: 'ins', heardIpa: 'ə' },
      ],
      clean: false,
    });
    reconcileAttempts(db, [coda]);
    expect([...noteEvidence(db).keys()], '插入点右边一格是空的，左边那格没算进去').toEqual(['coda-cluster']);
  });

  /**
   * 位置要在**过滤掉 match 之前**数，而且 ins 不消耗目标音——
   * 这跟 judge.ts 里 errorTags 的推法必须是同一套。ins 也算一格的话，
   * 它后面每一处错的结构标签都往后串一格，而那种错位悄无声息。
   */
  it('插入音后面还有一处错：那处错的位置不能被插入音顶偏', () => {
    const db = openDb(':memory:');
    const flap = note({ id: 'flap-t', triggers: ['flap-t'] });
    // little /l ɪ t ə l/：开头加塞一个 ə，然后闪音 t 念成了 d
    logAttempt(db, {
      entryText: 'little', target: 'little', at: '2026-08-02T00:00:00Z',
      targetIpa: ['l', 'ɪ', 't', 'ə', 'l'], heardIpa: ['l', 'ə', 'ɪ', 'd', 'ə', 'l'],
      ops: [
        { kind: 'match', targetIpa: 'l', heardIpa: 'l' },
        { kind: 'ins', heardIpa: 'ə' },
        { kind: 'match', targetIpa: 'ɪ', heardIpa: 'ɪ' },
        { kind: 'sub', targetIpa: 't', heardIpa: 'd' },      // flap-t 在下标 2
        { kind: 'match', targetIpa: 'ə', heardIpa: 'ə' },
        { kind: 'match', targetIpa: 'l', heardIpa: 'l' },
      ],
      clean: false,
    });
    reconcileAttempts(db, [flap]);
    expect([...noteEvidence(db).keys()], 'ins 把后面那处错的位置顶偏了一格').toEqual(['flap-t']);
  });

  // 按词声明范围的笔记按 target 匹配，而短语词条可以只录其中一个词。
  // 少了 attempt.target 这一列，重算只能拿整条去猜。
  it('短语里只录了一个词：按那个词匹配，不是按整条', () => {
    const db = openDb(':memory:');
    logAttempt(db, {
      entryText: 'the machine', target: 'machine', at: '2026-08-02T00:00:00Z',
      targetIpa: ['m', 'ə', 'ʃ', 'i', 'n'], heardIpa: ['m', 'ə', 'ʃ', 'aɪ', 'n'],
      ops: [
        { kind: 'match', targetIpa: 'm', heardIpa: 'm' },
        { kind: 'match', targetIpa: 'ə', heardIpa: 'ə' },
        { kind: 'match', targetIpa: 'ʃ', heardIpa: 'ʃ' },
        { kind: 'sub', targetIpa: 'i', heardIpa: 'aɪ' },
        { kind: 'match', targetIpa: 'n', heardIpa: 'n' },
      ],
      clean: false,
    });
    reconcileAttempts(db, [INE]);
    expect([...noteEvidence(db).keys()]).toEqual(['ine-spelling']);
  });

  it('一处错都没有的录音 → 一篇都不挂，哪怕有讲这个词的笔记', () => {
    const db = openDb(':memory:');
    logAttempt(db, {
      entryText: 'machine', target: 'machine', at: '2026-08-02T00:00:00Z',
      targetIpa: ['m', 'ə', 'ʃ', 'i', 'n'], heardIpa: ['m', 'ə', 'ʃ', 'i', 'n'],
      ops: [], clean: true,
    });
    reconcileAttempts(db, [INE]);
    expect(noteEvidence(db).size, '念对了也记了一笔"你有这个毛病"').toBe(0);
  });

  it('词典里查不到那个词了 → 不动它，如实计入 skipped', () => {
    const db = openDb(':memory:');
    const id = logAttempt(db, {
      entryText: 'anthropic', target: 'anthropic', at: '2026-08-02T00:00:00Z',
      targetIpa: ['æ', 'n'], heardIpa: ['æ', 'm'],
      ops: [{ kind: 'match', targetIpa: 'æ', heardIpa: 'æ' }, { kind: 'sub', targetIpa: 'n', heardIpa: 'm' }],
      clean: false,
    });
    putAttribution(db, id, ['l-vs-n']);
    const r = reconcileAttempts(db, [LVN]);
    expect(r.skipped).toBe(1);
    expect(r.changed).toEqual([]);
    expect([...noteEvidence(db).keys()], '算不出来却把已有的抹了').toEqual(['l-vs-n']);
  });

  it('算不出来时返回 null，不是空集合——"不知道"和"没有"是两回事', () => {
    expect(attributionOf('anthropic', [], [LVN])).toBeNull();
    expect(attributionOf('thin', [], [LVN])).toEqual(new Set());
  });
});
