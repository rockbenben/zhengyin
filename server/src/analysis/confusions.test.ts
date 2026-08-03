import { describe, it, expect } from 'vitest';
import { confusableSets, confusionContrasts } from './confusions.js';
import type { Note } from '../notes.js';

function note(id: string, triggers: string[]): Note {
  // words / contrasts 不能省：Note 上是必填的。省了一直没人发现，是因为
  // server/tsconfig.json 把测试文件 exclude 掉了——见 tsconfig.typecheck.json
  return { id, title: id, triggers, words: [], contrasts: [], severity: 'confirmed', markdown: '', file: `${id}.md` };
}

const lVsN = [note('l-vs-n', ['phoneme:l', 'phoneme:n'])];

describe('confusableSets', () => {
  it('pairs phonemes declared together in one note', () => {
    const sets = confusableSets(lVsN);
    expect(sets.get('l')).toEqual(new Set(['n']));
    expect(sets.get('n')).toEqual(new Set(['l']));
  });

  it('a note with only one phoneme trigger produces no pairing (nothing to confuse it with)', () => {
    expect(confusableSets([note('solo', ['phoneme:n'])]).has('n')).toBe(false);
  });

  it('non-phoneme triggers (cluster-onset:, clear-l, ...) are ignored', () => {
    expect(confusableSets([note('kl', ['cluster-onset:kl', 'clear-l'])]).size).toBe(0);
  });

  it('no notes → empty map', () => {
    expect(confusableSets([]).size).toBe(0);
  });
});

describe('confusionContrasts', () => {
  const words = (t: string, n = lVsN, max?: number) =>
    confusionContrasts(t, n, max).map((c) => c.word);

  it('light → 词首 /l/ 能换成 /n/（对比词是 night 的某个同音拼写）', () => {
    // 同音异形词（knight / night / nite）对识别语法完全等价，挑中哪个拼写不重要，
    // 所以这里断言的是**音素替换**这件事本身，不钉死拼写。
    const c = confusionContrasts('light', lVsN).find((x) => x.index === 0);
    expect(c).toMatchObject({ index: 0, targetIpa: 'l', partnerIpa: 'n' });
    expect(['night', 'knight', 'nite']).toContain(c!.word);
  });

  it('need → includes lead (mid-word vowel differs from need; only a phoneme-level ' +
     'lookup finds this — need = N IY1 D, lead = L EH1 D, not a spelling substitution)', () => {
    expect(words('need')).toContain('lead');
  });

  it('snip → includes slip (non-word-initial consonant swap)', () => {
    expect(words('snip')).toContain('slip');
  });

  it('snack → includes slack (non-word-initial consonant swap)', () => {
    expect(words('snack')).toContain('slack');
  });

  it('never includes the target word itself', () => {
    expect(words('light')).not.toContain('light');
  });

  it('a word with no confusable phonemes (no notes declare any of its phonemes) → []', () => {
    expect(confusionContrasts('cat', [])).toEqual([]);
  });

  it('a word not in CMUdict → [] (never throws)', () => {
    expect(confusionContrasts('zzxxqq', lVsN)).toEqual([]);
  });

  it('respects the max cap', () => {
    expect(confusionContrasts('light', lVsN, 0)).toEqual([]);
  });

  // ↓ 位置信息是音素级听辨的全部依据：没有它，听辨只能说"整个词像不像"，
  //   说不出"你第几个音发错了"。以下几条盯的就是这个下标本身。

  it('标出替换发生在第几个音素，以及两边各是什么音', () => {
    // snack = S N AE1 K，被换的是第 1 个音素（N→L），得到 slack。
    const c = confusionContrasts('snack', lVsN).find((x) => x.word === 'slack');
    expect(c).toEqual({ word: 'slack', index: 1, targetIpa: 'n', partnerIpa: 'l' });
  });

  it('非词首位置的下标是真实位置，不是恒为 0', () => {
    // snip = S N IH1 P，被换的是第 1 个音素（N），不是第 0 个（S）。
    // 这条防的是"下标写死 0"或"用了错的循环变量"——那样 UI 会把错误指到 /s/ 上。
    const c = confusionContrasts('snip', lVsN).find((x) => x.word === 'slip');
    expect(c).toEqual({ word: 'slip', index: 1, targetIpa: 'n', partnerIpa: 'l' });
  });

  it('targetIpa 确实取自 target 的那个位置，跟 partnerIpa 不同', () => {
    for (const c of confusionContrasts('nine', lVsN)) {
      expect(c.targetIpa).not.toBe(c.partnerIpa);
    }
  });

  it('同一个音素位置最多产出一个搭档词（同音异形词只留一个，别浪费识别次数）', () => {
    // nine = N AY1 N，两个 n 都可换，所以应当有两个不同下标的对比，
    // 但同一下标不该出现两次。
    const cs = confusionContrasts('nine', lVsN);
    const indices = cs.map((c) => c.index);
    expect(new Set(indices).size).toBe(indices.length);
  });
});
