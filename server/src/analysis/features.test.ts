import { describe, it, expect } from 'vitest';
import { parsePhones } from './phones.js';
import { syllabify } from './syllables.js';
import { extractTags, attributeTags } from './features.js';

function tags(arpabet: string[]) {
  const p = parsePhones(arpabet);
  return extractTags(p, syllabify(p));
}

function perPhone(arpabet: string[]) {
  const p = parsePhones(arpabet);
  return attributeTags(p, syllabify(p));
}

describe('extractTags', () => {
  it('click → phonemes + cluster-onset:kl + clear-l, no dark-l', () => {
    const t = tags(['K', 'L', 'IH1', 'K']);
    expect(t).toContain('phoneme:l');
    expect(t).toContain('phoneme:k');
    expect(t).toContain('cluster-onset:kl');
    expect(t).toContain('clear-l');
    expect(t).not.toContain('dark-l');
  });
  /**
   * 音节**尾**的辅音连缀。补得比 onset 晚——原来只有 onset 有标签，于是讲词尾连缀的
   * 笔记没法声明适用范围，只能退回按词挂（detox 那篇就是这样，box / six / fix 一个都挂不上）。
   * 而「音节结尾的辅音」按影响听懂的程度排，是中文母语者的第一号短板。
   */
  it('box → cluster-coda:ks，词尾两个辅音都带上这个标签', () => {
    const t = tags(['B', 'AA1', 'K', 'S']);
    expect(t).toContain('cluster-coda:ks');
    // 逐音素归属：k 和 s 两个都要挂上，否则音素条上点其中一个跳不到这篇笔记
    const per = perPhone(['B', 'AA1', 'K', 'S']);
    expect(per[2].tags).toContain('cluster-coda:ks');
    expect(per[3].tags).toContain('cluster-coda:ks');
    // 词首的 b 不该沾上
    expect(per[0].tags).not.toContain('cluster-coda:ks');
  });

  it('next → cluster-coda:kst，三个辅音也算一串', () => {
    expect(tags(['N', 'EH1', 'K', 'S', 'T'])).toContain('cluster-coda:kst');
  });

  it('单个词尾辅音不算连缀（那该写 phoneme:）', () => {
    // book /bʊk/ 词尾只有一个 k
    expect(tags(['B', 'UH1', 'K']).some((t) => t.startsWith('cluster-coda:'))).toBe(false);
  });

  it('词首连缀不会被误当成词尾连缀', () => {
    // click /klɪk/：kl 在 onset，词尾只有单个 k
    const t = tags(['K', 'L', 'IH1', 'K']);
    expect(t).toContain('cluster-onset:kl');
    expect(t.some((x) => x.startsWith('cluster-coda:'))).toBe(false);
  });

  it('feel → dark-l, no clear-l', () => {
    const t = tags(['F', 'IY1', 'L']);
    expect(t).toContain('dark-l');
    expect(t).not.toContain('clear-l');
    expect(t).not.toContain('cluster-onset:fl'); // f 和 l 不同音节位置
  });
  it('water → flap-t', () => {
    expect(tags(['W', 'AO1', 'T', 'ER0'])).toContain('flap-t');
  });
  it('tone (stressed second vowel) → no flap', () => {
    // A T OW1 N 式：t 后是重读元音，不闪
    expect(tags(['AH0', 'T', 'OW1', 'N'])).not.toContain('flap-t');
  });
  it('strict → cluster-onset:str', () => {
    expect(tags(['S', 'T', 'R', 'IH1', 'K', 'T'])).toContain('cluster-onset:str');
  });
  it('tags are unique', () => {
    const t = tags(['K', 'L', 'IH1', 'K']);
    expect(new Set(t).size).toBe(t.length);
  });
});

describe('attributeTags', () => {
  it('click (K L IH1 K) → K and L both carry cluster-onset:kl, L also carries clear-l + phoneme:l', () => {
    const p = perPhone(['K', 'L', 'IH1', 'K']);
    expect(p).toHaveLength(4);
    // 词首的 K：属于 /kl/ 连缀的一部分
    expect(p[0].tags).toContain('cluster-onset:kl');
    expect(p[0].tags).toContain('phoneme:k');
    // L：既是连缀成员，本身又是元音前的 clear l
    expect(p[1].tags).toContain('cluster-onset:kl');
    expect(p[1].tags).toContain('clear-l');
    expect(p[1].tags).toContain('phoneme:l');
    expect(p[1].tags).not.toContain('dark-l');
    // 元音和词尾的 K 不参与这个连缀 tag
    expect(p[2].tags).not.toContain('cluster-onset:kl');
    expect(p[3].tags).not.toContain('cluster-onset:kl');
  });

  it('feel (F IY1 L) → 词尾的 L 挂 dark-l，不挂 clear-l', () => {
    const p = perPhone(['F', 'IY1', 'L']);
    const l = p[2];
    expect(l.tags).toContain('dark-l');
    expect(l.tags).not.toContain('clear-l');
    expect(l.tags).toContain('phoneme:l');
  });

  it('water (W AO1 T ER0) → 具体是那个 T 挂 flap-t，其余音素不挂', () => {
    const p = perPhone(['W', 'AO1', 'T', 'ER0']);
    expect(p[2].tags).toContain('flap-t');
    expect(p[0].tags).not.toContain('flap-t');
    expect(p[1].tags).not.toContain('flap-t');
    expect(p[3].tags).not.toContain('flap-t');
  });

  it('每个音素都至少携带自己的 phoneme:<ipa>', () => {
    const p = perPhone(['S', 'T', 'R', 'IH1', 'K', 'T']);
    expect(p.map((x) => x.tags[0])).toEqual([
      'phoneme:s', 'phoneme:t', 'phoneme:r', 'phoneme:ɪ', 'phoneme:k', 'phoneme:t',
    ]);
  });

  it('extractTags 的拍平输出恒等于 attributeTags 逐音素结果的并集（两者不可能失步）', () => {
    const words = [
      ['K', 'L', 'IH1', 'K'],       // click
      ['F', 'IY1', 'L'],            // feel
      ['W', 'AO1', 'T', 'ER0'],     // water
      ['AH0', 'T', 'OW1', 'N'],     // tone
      ['S', 'T', 'R', 'IH1', 'K', 'T'], // strict
    ];
    for (const arpabet of words) {
      const flat = new Set(tags(arpabet));
      const union = new Set(perPhone(arpabet).flatMap((p) => p.tags));
      expect(flat).toEqual(union);
    }
  });
});

/**
 * 词尾的浊辅音。
 *
 * 中文音节收不了浊辅音（只能以元音 / n / ng 收尾），所以 bed→bet、dog→dock、
 * have→half——清化之后变成另一个词。这是「音节结尾的辅音」（美音要点第 1 条）
 * 的另一半：cluster-coda 管"两个辅音都要发出来"，这条管"最后那个不许把喉咙关掉"。
 */
describe('final-voiced：词尾的浊阻塞音', () => {
  const has = (arpabet: string[]) => tags(arpabet).includes('final-voiced');

  it.each([
    ['bed  /bɛd/', ['B', 'EH1', 'D']],
    ['dog  /dɔɡ/', ['D', 'AO1', 'G']],
    ['have /hæv/', ['HH', 'AE1', 'V']],
    ['is   /ɪz/', ['IH1', 'Z']],
    ['badge /bædʒ/', ['B', 'AE1', 'JH']],
  ])('%s → 有 final-voiced', (_label, arpabet) => {
    expect(has(arpabet)).toBe(true);
  });

  it.each([
    ['bet  /bɛt/ 清辅音收尾', ['B', 'EH1', 'T']],
    ['dock /dɑk/ 清辅音收尾', ['D', 'AA1', 'K']],
    ['half /hæf/ 清辅音收尾', ['HH', 'AE1', 'F']],
    ['day  /deɪ/ 元音收尾', ['D', 'EY1']],
  ])('%s → 没有', (_label, arpabet) => {
    expect(has(arpabet)).toBe(false);
  });

  // **只标阻塞音。** 浊的鼻音和流音（m n ŋ l r）本来就没有清化问题——
  // 标了就等于给每个以 n 结尾的词挂一篇不相干的笔记，而这个仓库刚因为
  // 「没发错也出现」这件事把词条页的判据整个改过一次。
  it.each([
    ['man  /mæn/ 鼻音', ['M', 'AE1', 'N']],
    ['sing /sɪŋ/ 鼻音', ['S', 'IH1', 'NG']],
    ['bell /bɛl/ 边音', ['B', 'EH1', 'L']],
    ['car  /kɑɹ/ 近音', ['K', 'AA1', 'R']],
  ])('%s → 没有（浊但不是阻塞音）', (_label, arpabet) => {
    expect(has(arpabet)).toBe(false);
  });

  it('只标最后那一个，词首词中的浊辅音不标', () => {
    // bad /bæd/：开头的 /b/ 也是浊阻塞音，但它不在词尾
    const per = perPhone(['B', 'AE1', 'D']);
    expect(per[0].tags, '词首的 /b/ 被标上了').not.toContain('final-voiced');
    expect(per[2].tags, '词尾的 /d/ 没被标').toContain('final-voiced');
  });
});
