import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { shelfOf, compareShelf, coversOf } from './shelf.js';
import { NoteStore } from './notes.js';
import { PLACES } from './analysis/articulation.js';

const note = (triggers: string[], words: string[] = []) => ({ triggers, words });

describe('一篇笔记落在哪一格书架上', () => {
  it('只声明 words 的是「讲词的」', () => {
    expect(shelfOf(note([], ['machine', 'routine'])).shelf).toBe('word');
  });

  it('结构标签和连缀是「位置与连缀」', () => {
    expect(shelfOf(note(['dark-l'])).shelf).toBe('structure');
    expect(shelfOf(note(['flap-t'])).shelf).toBe('structure');
    expect(shelfOf(note(['final-voiced'])).shelf).toBe('structure');
    expect(shelfOf(note(['cluster-onset:kl', 'cluster-onset:pl'])).shelf).toBe('structure');
    expect(shelfOf(note(['cluster-coda:ks'])).shelf).toBe('structure');
  });

  it('音素 trigger 按元音/辅音分', () => {
    expect(shelfOf(note(['phoneme:θ', 'phoneme:ð'])).shelf).toBe('consonant');
    expect(shelfOf(note(['phoneme:ɑ', 'phoneme:æ'])).shelf).toBe('vowel');
  });

  // 一篇笔记可以覆盖跨部位的两个音（n 齿龈 / ŋ 软腭）。摆在**最靠前**那一格：
  // 跟同样在齿龈的 l-n 挨着，比丢到软腭去有用——统计页的音位格想让人看见的
  // 正是「几个看起来不同的毛病其实是同一个部位」。
  it('跨部位时取最靠前的那个部位', () => {
    expect(shelfOf(note(['phoneme:n', 'phoneme:ŋ'])).placeLabel).toBe('齿龈');
    expect(shelfOf(note(['phoneme:ŋ', 'phoneme:n'])).placeLabel, '跟声明顺序无关').toBe('齿龈');
  });

  it('讲词的笔记路标摆那几个词，音素笔记摆 IPA', () => {
    expect(coversOf(note([], ['machine']))).toEqual(['machine']);
    expect(coversOf(note(['phoneme:l', 'phoneme:n']))).toEqual(['l', 'n']);
  });

  it('排序：辅音（唇→喉）→ 元音 → 位置与连缀 → 讲词的', () => {
    const mk = (t: string[], w: string[], title: string) => ({ ...shelfOf(note(t, w)), title });
    const list = [
      mk([], ['machine'], '讲词的'),
      mk(['dark-l'], [], '结构'),
      mk(['phoneme:ɑ'], [], '元音'),
      mk(['phoneme:ʃ'], [], '龈后辅音'),
      mk(['phoneme:v'], [], '唇齿辅音'),
    ].sort(compareShelf);
    expect(list.map((x) => x.title)).toEqual(['唇齿辅音', '龈后辅音', '元音', '结构', '讲词的']);
  });
});

/**
 * 拿**仓库里真实的 notes/** 核对，跟 notes.shape.test.ts 同一个路子。
 *
 * 单元用例只证规则自洽；这一组证的是规则套在真数据上不掉链子——
 * 尤其是「辅音笔记必须查得到部位」：某个音素没进 articulation 表的话，
 * 它会静默落成 place=null，在界面上掉出所有部位小标题，而没有任何东西会报警。
 */
describe('真实的 notes/ 全都摆得进去', () => {
  const store = new NoteStore(join(import.meta.dirname, '..', '..', 'notes'));
  store.load();
  const all = store.all();

  it('一篇都不落空', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) {
      expect(['consonant', 'vowel', 'structure', 'word'], n.id).toContain(shelfOf(n).shelf);
    }
  });

  it('辅音笔记全都查得到部位，而且是表里有的那几个', () => {
    const ids = PLACES.map((p) => p.id);
    for (const n of all) {
      const s = shelfOf(n);
      if (s.shelf !== 'consonant') continue;
      expect(s.place, `${n.id} 的部位查不到——音素进 articulation 表了吗`).not.toBeNull();
      expect(ids).toContain(s.place);
    }
  });

  it('每篇都给得出路标，不会是空的', () => {
    for (const n of all) expect(coversOf(n).length, n.id).toBeGreaterThan(0);
  });
});
