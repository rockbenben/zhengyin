import { describe, it, expect } from 'vitest';
import { analyzeText } from './service.js';

describe('analyzeText', () => {
  it('analyzes click', () => {
    const [w] = analyzeText('click');
    expect(w).toMatchObject({ word: 'click', found: true, ipa: 'ˈklɪk' });
    expect(w.tags).toContain('cluster-onset:kl');
  });
  it('phrase → one WordAnalysis per word', () => {
    const ws = analyzeText('Dopamine Detox');
    expect(ws.map((w) => w.word)).toEqual(['dopamine', 'detox']);
  });
  it('unknown word: found=false, empty tags, ipaOverride respected', () => {
    const [w] = analyzeText('zzzzqqq', '/zɪk/');
    expect(w.found).toBe(false);
    expect(w.ipa).toBe('/zɪk/');
    expect(w.tags).toEqual([]);
  });
});

/**
 * 逐音节的重音级别。
 *
 * 压成"主重音在第几节"一个下标是不够的：那样"其余都是轻读"就成了默认结论，
 * 而 dopamine 是 1-0-2——词尾 -mine 是**次重音**、元音是满的 /miːn/。
 * 把它并进轻读，界面上就会多出一句假话，而这个词恰好是使用者练得最多的那个。
 */
describe('analyzeText 的 syllableStress', () => {
  const of = (w: string) => analyzeText(w)[0];

  it('dopamine 是 主重音-轻读-次重音，三级都要留住', () => {
    expect(of('dopamine').syllableStress).toEqual([1, 0, 2]);
  });

  it('machine 是 轻读-主重音', () => {
    expect(of('machine').syllableStress).toEqual([0, 1]);
  });

  it('跟 syllables 等长——两者同下标对应，界面靠这个把标记贴到对的那一节', () => {
    for (const w of ['dopamine', 'machine', 'every', 'thin']) {
      const a = of(w);
      expect(a.syllableStress, w).toHaveLength(a.syllables!.length);
    }
  });

  it('词典里查不到的词给空数组，不编', () => {
    expect(of('zzzqqq').syllableStress).toEqual([]);
  });
});
