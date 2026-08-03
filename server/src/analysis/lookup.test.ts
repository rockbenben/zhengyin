import { describe, it, expect } from 'vitest';
import { tokenize, lookupWord } from './lookup.js';

describe('tokenize', () => {
  it('splits on spaces and hyphens', () => {
    expect(tokenize('Dopamine Detox')).toEqual(['dopamine', 'detox']);
    expect(tokenize('well-being')).toEqual(['well', 'being']);
    expect(tokenize('  click  ')).toEqual(['click']);
  });
});

describe('lookupWord', () => {
  it('finds click = K L IH1 K', () => {
    expect(lookupWord('click')!.map((p) => p.arpabet)).toEqual(['K', 'L', 'IH1', 'K']);
  });
  it('is case-insensitive', () => {
    expect(lookupWord('CLICK')).not.toBeNull();
  });
  it('returns null for unknown word', () => {
    expect(lookupWord('zzzzqqq')).toBeNull();
  });
  it('strips comments from dictionary entries', () => {
    expect(lookupWord('hiv')!.map((p) => p.arpabet)).toEqual(['EY1', 'CH', 'AY1', 'V', 'IY1']);
  });

  // 回归：dictionary 是普通对象，dictionary['__proto__'] 返回 Object.prototype（真值），
  // 只判真值的话后面 raw.split 会 TypeError 冲出 Hono handler，让 POST /api/entries
  // {"text":"__proto__"} 变成 500。修好后它只是普通的"词典里没有"，返回 null。
  it('returns null for prototype keys instead of throwing', () => {
    expect(lookupWord('__proto__')).toBeNull();
    expect(lookupWord('constructor')).not.toBeNull(); // 真实词典条目不受影响
  });
});

describe('CMUdict 错条修正', () => {
  it('dopamine 修成 /ˈdoʊpəˌmiːn/，不是词典里的 DAH-puh-mine', () => {
    // CMUdict 写的是 D AA1 P AH0 M AY2 N，两处都错，用词典自己的数据就能证：
    // -amine 一族全是 M IY2 N（histamine/amphetamine/melamine），只有它是 M AY2 N；
    // 词干 dopa/dope 都是 D OW1 P，它却写成 D AA1 P。
    // 后果不只是显示错——念对了会被评测报成两个音发错，还会据此建复习卡、
    // 往发音档案里写一条不存在的短板。
    expect(lookupWord('dopamine')!.map((p) => p.ipa)).toEqual(['d', 'oʊ', 'p', 'ə', 'm', 'i', 'n']);
  });

  it('修正表不影响别的词', () => {
    expect(lookupWord('detox')!.map((p) => p.ipa)).toEqual(['d', 'i', 't', 'ɑ', 'k', 's']);
    expect(lookupWord('histamine')!.map((p) => p.ipa).slice(-3)).toEqual(['m', 'i', 'n']);
  });

  it('大小写不敏感', () => {
    expect(lookupWord('Dopamine')!.map((p) => p.ipa)[1]).toBe('oʊ');
    expect(lookupWord('DOPAMINE')!.map((p) => p.ipa)[1]).toBe('oʊ');
  });

  it('原型上的键不会把真词挡掉', () => {
    // 修正表若用对象字面量，CORRECTIONS['constructor'] 会拿到 Function 构造器
    // （真值、非 null），于是 `?? dictionary[key]` 永远轮不到——「constructor」
    // 这个真词就查不到了。用 Map 才免疫。
    // constructor 在 CMUdict 里确实有（K AH0 N S T R AH1 K T ER0），必须查得到
    expect(lookupWord('constructor')!.map((p) => p.ipa)[0]).toBe('k');
    // toString / __proto__ 词典里本来就没有，返回 null 是对的（不是被原型挡掉）
    expect(lookupWord('__proto__')).toBeNull();
    expect(lookupWord('toString')).toBeNull();
  });
});
