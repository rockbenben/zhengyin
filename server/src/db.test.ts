import { describe, it, expect } from 'vitest';
import { heardByPosition, logAttempt, openDb, upsertEntry, getEntry, listEntries, deleteEntry, addAudio, getAudio, audioFileInUse } from './db.js';

const words = [{
  word: 'click', found: true, arpabet: ['K', 'L', 'IH1', 'K'], ipa: 'ˈklɪk', tags: ['phoneme:l'],
  phoneIpa: ['k', 'l', 'ɪ', 'k'], phoneTags: [[], [], [], []],
  syllables: [[0, 1, 2, 3]], syllableStress: [1],
}];

describe('db', () => {
  it('upsert + get roundtrip', () => {
    const db = openDb(':memory:');
    upsertEntry(db, 'click', words, '2026-07-28T00:00:00Z');
    const e = getEntry(db, 'click')!;
    expect(e.words[0].ipa).toBe('ˈklɪk');
  });

  it('upsert twice keeps one row, bumps updatedAt', () => {
    const db = openDb(':memory:');
    upsertEntry(db, 'click', words, 't1');
    upsertEntry(db, 'click', words, 't2');
    expect(listEntries(db)).toHaveLength(1);
    expect(getEntry(db, 'click')!.updatedAt).toBe('t2');
    expect(getEntry(db, 'click')!.createdAt).toBe('t1');
  });

  it('audio add/get, delete returns audio rows', () => {
    const db = openDb(':memory:');
    upsertEntry(db, 'click', words, 't1');
    addAudio(db, { entryText: 'click', word: 'click', source: 'mw', file: 'click-mw.mp3' });
    expect(getAudio(db, 'click')).toHaveLength(1);
    const removed = deleteEntry(db, 'click');
    expect(removed[0].file).toBe('click-mw.mp3');
    expect(getEntry(db, 'click')).toBeNull();
    expect(getAudio(db, 'click')).toHaveLength(0);
  });

  it('phoneIpa/phoneTags round-trip through the words_json blob unchanged', () => {
    const db = openDb(':memory:');
    const withPhoneTags = [{
      ...words[0],
      phoneIpa: ['k', 'l', 'ɪ', 'k'],
      phoneTags: [['phoneme:k', 'cluster-onset:kl'], ['phoneme:l', 'cluster-onset:kl', 'clear-l'], ['phoneme:ɪ'], ['phoneme:k']],
    }];
    upsertEntry(db, 'click', withPhoneTags, 't1');
    const e = getEntry(db, 'click')!;
    expect(e.words[0].phoneIpa).toEqual(['k', 'l', 'ɪ', 'k']);
    expect(e.words[0].phoneTags).toEqual(withPhoneTags[0].phoneTags);
  });

  it('audioFileInUse reflects whether any remaining audio row references a filename', () => {
    const db = openDb(':memory:');
    upsertEntry(db, 'black cat', words, 't1');
    upsertEntry(db, 'black', words, 't1');
    addAudio(db, { entryText: 'black cat', word: 'black', source: 'mw', file: 'black-mw.mp3' });
    addAudio(db, { entryText: 'black', word: 'black', source: 'mw', file: 'black-mw.mp3' });
    expect(audioFileInUse(db, 'black-mw.mp3')).toBe(true);
    deleteEntry(db, 'black cat');
    // "black" still has a row pointing at the same shared filename.
    expect(audioFileInUse(db, 'black-mw.mp3')).toBe(true);
    deleteEntry(db, 'black');
    expect(audioFileInUse(db, 'black-mw.mp3')).toBe(false);
  });

});

/**
 * 逐位统计只能拿**长度相同**的流水来算——有增删的那些位置已经错开了，
 * 混进来会把统计算到别的音头上，而那正是要用它去纠正参考基准的地方。
 */
describe('heardByPosition', () => {
  it('长度不等的流水不参与逐位统计', () => {
    const db = openDb(':memory:');
    const target = ['n', 'aɪ', 't'];
    const log = (heard: string[]) => logAttempt(db, {
      entryText: 'night', target: 'night', at: '2026-07-31T00:00:00Z', targetIpa: target, heardIpa: heard,
      ops: [], clean: false,
    });
    log(['n', 'eɪ', 't']);
    log(['n', 'eɪ', 't']);
    log(['n', 'eɪ']);                 // 少一个音：位置已经错开
    log(['n', 'eɪ', 't', 'ə']);       // 多一个音：同样错开

    const seen = heardByPosition(db, 'night', target);
    // 第 1 位只该数到两次 eɪ——把那两条错位的算进来就变成 4 次了
    expect(seen[1].eɪ).toBe(2);
  });

  it('目标序列不同的流水也不参与', () => {
    const db = openDb(':memory:');
    logAttempt(db, {
      entryText: 'night', target: 'night', at: '2026-07-31T00:00:00Z',
      targetIpa: ['l', 'aɪ', 't'], heardIpa: ['n', 'aɪ', 't'], ops: [], clean: false,
    });
    expect(heardByPosition(db, 'night', ['n', 'aɪ', 't'])[0]).toEqual({});
  });
});
