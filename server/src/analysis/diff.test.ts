import { describe, it, expect } from 'vitest';
import { parsePhones } from './phones.js';
import { phonemeSubs, alignPhonemes, renameTargets } from './diff.js';

describe('phonemeSubs', () => {
  it('light vs night → l/n substitution', () => {
    const subs = phonemeSubs(parsePhones(['L', 'AY1', 'T']), parsePhones(['N', 'AY1', 'T']));
    expect(subs).toEqual([{ targetIpa: 'l', heardIpa: 'n' }]);
  });
  it('identical → empty', () => {
    expect(phonemeSubs(parsePhones(['K', 'L', 'IH1', 'K']), parsePhones(['K', 'L', 'IH1', 'K']))).toEqual([]);
  });
  it('insertion/deletion not reported as subs', () => {
    // click vs kick：l 被删，无替换对
    expect(phonemeSubs(parsePhones(['K', 'L', 'IH1', 'K']), parsePhones(['K', 'IH1', 'K']))).toEqual([]);
  });
});

// alignPhonemes 是音素级听辨的核心：它要能说清三种错法。只报替换是不够的——
// 中文母语者最典型的两个问题恰恰是 del（辅音连缀漏音、词尾吞音）和 ins（辅音之间
// 加塞元音，把 click 念成"克-里-克"）。
describe('alignPhonemes', () => {
  const kinds = (t: string[], h: string[]) => alignPhonemes(t, h).map((o) => o.kind);

  it('完全一致 → 全是 match', () => {
    expect(alignPhonemes(['n', 'aɪ', 't'], ['n', 'aɪ', 't'])).toEqual([
      { kind: 'match', targetIpa: 'n', heardIpa: 'n' },
      { kind: 'match', targetIpa: 'aɪ', heardIpa: 'aɪ' },
      { kind: 'match', targetIpa: 't', heardIpa: 't' },
    ]);
  });

  it('替换：night 念成 light', () => {
    expect(alignPhonemes(['n', 'aɪ', 't'], ['l', 'aɪ', 't'])[0])
      .toEqual({ kind: 'sub', targetIpa: 'n', heardIpa: 'l' });
  });

  it('漏音：click 的 /l/ 没发出来 → del', () => {
    // 辅音连缀里丢掉一个辅音，是 kl 那篇笔记讲的问题之一。只报替换的话这里
    // 什么都报不出来——用户会以为自己念对了。
    const ops = alignPhonemes(['k', 'l', 'ɪ', 'k'], ['k', 'ɪ', 'k']);
    expect(ops.filter((o) => o.kind === 'del')).toEqual([{ kind: 'del', targetIpa: 'l' }]);
    expect(kinds(['k', 'l', 'ɪ', 'k'], ['k', 'ɪ', 'k'])).toEqual(['match', 'del', 'match', 'match']);
  });

  it('加塞元音：click 念成"克-里-克" → ins', () => {
    // /k/ 和 /l/ 之间多出一个 ə，正是 kl-click 笔记的核心误区。
    const ops = alignPhonemes(['k', 'l', 'ɪ', 'k'], ['k', 'ə', 'l', 'ɪ', 'k']);
    expect(ops.filter((o) => o.kind === 'ins')).toEqual([{ kind: 'ins', heardIpa: 'ə' }]);
  });

  it('词尾吞音 → del 落在最后一个音素上', () => {
    const ops = alignPhonemes(['b', 'l', 'æ', 'k'], ['b', 'l', 'æ']);
    expect(ops.at(-1)).toEqual({ kind: 'del', targetIpa: 'k' });
  });

  it('什么都没听出来 → 目标的每个音素各一个 del', () => {
    expect(alignPhonemes(['n', 'aɪ', 't'], [])).toEqual([
      { kind: 'del', targetIpa: 'n' },
      { kind: 'del', targetIpa: 'aɪ' },
      { kind: 'del', targetIpa: 't' },
    ]);
  });

  it('目标为空 → 听到的每个音素各一个 ins（不崩、不丢）', () => {
    expect(alignPhonemes([], ['n', 'aɪ'])).toEqual([
      { kind: 'ins', heardIpa: 'n' },
      { kind: 'ins', heardIpa: 'aɪ' },
    ]);
  });

  it('两边都空 → 空数组', () => {
    expect(alignPhonemes([], [])).toEqual([]);
  });

  it('每个目标音素恰好被一条 match/sub/del 覆盖一次，一个都不漏', () => {
    // 这条是总闸：回溯写错（比如某个分支忘了 unshift）会让某些音素凭空消失，
    // 结果看着仍然"合理"，但用户漏发的音再也不会被指出来。
    const cases: Array<[string[], string[]]> = [
      [['k', 'l', 'ɪ', 'k'], ['k', 'ɪ', 'k']],
      [['k', 'l', 'ɪ', 'k'], ['k', 'ə', 'l', 'ɪ', 'k']],
      [['w', 'ɔ', 't', 'ɝ'], ['w', 'ɑ', 't', 'ɝ']],
      [['n', 'aɪ', 't'], ['l', 'aɪ', 'd']],
      [['s', 'n', 'ɪ', 'p'], ['s', 'l', 'ɪ', 'p']],
    ];
    for (const [t, h] of cases) {
      const ops = alignPhonemes(t, h);
      expect(ops.filter((o) => 'targetIpa' in o).map((o) => (o as { targetIpa: string }).targetIpa)).toEqual(t);
      expect(ops.filter((o) => 'heardIpa' in o).map((o) => (o as { heardIpa: string }).heardIpa)).toEqual(h);
    }
  });
});

// 声学比对的基准是参考录音的模型转写，但报错要用词典的音标说话——
// 不然界面会甩出模型内部的符号（"你把 /æ/ 发成了 /ʊ/"，而 book 的目标本来就是 /ʊ/）。
describe('renameTargets', () => {
  it('按位置把 targetIpa 换成另一套命名', () => {
    // 基准（参考转写）b æ k，你发成了 b ʊ k；命名用词典的 b ʊ k
    const ops = alignPhonemes(['b', 'æ', 'k'], ['b', 'ʊ', 'k']);
    const renamed = renameTargets(ops, ['b', 'ʊ', 'k']);
    expect(renamed.map((o) => ('targetIpa' in o ? o.targetIpa : null))).toEqual(['b', 'ʊ', 'k']);
    // heardIpa 不动
    expect(renamed[1]).toMatchObject({ kind: 'sub', targetIpa: 'ʊ', heardIpa: 'ʊ' });
  });

  it('ins 不消耗目标位置，命名不会错位', () => {
    // 目标 k l ɪ k，多发了一个 ə：ins 那一步不该占用命名序列的位置
    const ops = alignPhonemes(['k', 'l', 'ɪ', 'k'], ['k', 'ə', 'l', 'ɪ', 'k']);
    const renamed = renameTargets(ops, ['k', 'l', 'ɪ', 'k']);
    expect(renamed.filter((o) => 'targetIpa' in o).map((o) => (o as { targetIpa: string }).targetIpa))
      .toEqual(['k', 'l', 'ɪ', 'k']);
    expect(renamed.find((o) => o.kind === 'ins')).toEqual({ kind: 'ins', heardIpa: 'ə' });
  });

  it('del 也消耗目标位置', () => {
    const ops = alignPhonemes(['k', 'l', 'ɪ', 'k'], ['k', 'ɪ', 'k']);
    const renamed = renameTargets(ops, ['K', 'L', 'I', 'K']);
    expect(renamed.filter((o) => 'targetIpa' in o).map((o) => (o as { targetIpa: string }).targetIpa))
      .toEqual(['K', 'L', 'I', 'K']);
  });

  it('命名序列长度不对时原样返回，绝不错位命名', () => {
    // 错位命名比不命名糟得多：它会给出一个看着合理、实际张冠李戴的诊断
    const ops = alignPhonemes(['b', 'æ', 'k'], ['b', 'ʊ', 'k']);
    expect(renameTargets(ops, ['b', 'ʊ'])).toBe(ops);
    expect(renameTargets(ops, ['b', 'ʊ', 'k', 's'])).toBe(ops);
  });

  it('空输入不崩', () => {
    expect(renameTargets([], [])).toEqual([]);
  });
});

/**
 * ── 对齐的代价表：跨类替换要比同类贵半格 ──
 *
 * 这一节守的是一个**已经污染了数据库**的 bug，不是假想的边角。
 *
 * 纯 Levenshtein 里 sub 和 del 一样贵，长度差 1 时两种对齐同价，回溯从尾巴往回走、
 * 先试 sub，于是**词尾吞音一律被摊成「前一个音没发出来 + 最后一个音发成了别的」**。
 * 实测数据（attempt 198、217 等）：
 *
 *     thin  目标 θ ɪ n   听到 θ i   →  θ (缺ɪ) [n→i]
 *
 * 后果不是显示难看，是那两条假错误一路写进 attempt_error，在发音档案里堆成
 * 「把 /n/ 发成了 /i/ 7 次」「/i/ 没发出来 8 次」，双双排进「该补的笔记」，
 * 指挥人去写两篇根本不存在的毛病的笔记。/n/ 跟 /i/ 一个辅音一个元音，
 * 这种"替换"几乎必然是对齐没对齐上。
 */
describe('对齐代价：跨类替换比同类贵', () => {
  const show = (ops: ReturnType<typeof alignPhonemes>) => ops.map((o) =>
    o.kind === 'match' ? o.targetIpa
      : o.kind === 'sub' ? `[${o.targetIpa}>${o.heardIpa}]`
        : o.kind === 'del' ? `(-${o.targetIpa})` : `(+${o.heardIpa})`).join(' ');

  it('词尾吞音就报成吞音，不摊到前一个音上', () => {
    // thin /θɪn/ 念成了「θ-i」：元音有点走样，词尾 /n/ 没收
    expect(show(alignPhonemes(['θ', 'ɪ', 'n'], ['θ', 'i']))).toBe('θ [ɪ>i] (-n)');
  });

  it('长词也一样：错的是词尾那个辅音，不是倒数第二个元音', () => {
    // dopamine 目标 d oʊ p ə m i n，听到 d ɔ p ʌ m i —— 只有词尾 /n/ 丢了
    expect(show(alignPhonemes(
      ['d', 'oʊ', 'p', 'ə', 'm', 'i', 'n'],
      ['d', 'ɔ', 'p', 'ʌ', 'm', 'i'],
    ))).toBe('d [oʊ>ɔ] p [ə>ʌ] m i (-n)');
  });

  it('辅音元音化仍然报成一次替换，不拆成"缺一个+多一个"', () => {
    // 暗 L 念成 /ʊ/（milk → "miuk"）是中文母语者的真实错法，一对一的时候
    // 就该说"把 /l/ 发成了 /ʊ/"。所以跨类的罚金要**小于**一删一增。
    expect(show(alignPhonemes(['m', 'ɪ', 'l', 'k'], ['m', 'ɪ', 'ʊ', 'k']))).toBe('m ɪ [l>ʊ] k');
  });

  it('同类替换照旧：l→n 一个字都没变', () => {
    expect(show(alignPhonemes(['l', 'aɪ', 't'], ['n', 'aɪ', 't']))).toBe('[l>n] aɪ t');
  });

  it('加塞的元音照旧报成"多发了一个"', () => {
    // click 念成「克-里-克」，这个仓库的招牌错误
    expect(show(alignPhonemes(['k', 'l', 'ɪ', 'k'], ['k', 'ə', 'l', 'ɪ', 'k']))).toBe('k (+ə) l ɪ k');
  });

  it('表里查不到的符号不加罚——没有判据就不判', () => {
    // 模型偶尔吐归一化认不出的东西（attempt 253 实测转出过裸 `o`）。判不出元音还是
    // 辅音时按同类算，不能因为"不认识"就罚它一格、把它推去当漏音。
    //
    // 目标侧也会有认不出的符号：**参考基准本身就是模型转写**。这里就摆成那个样子——
    // 基准 [d o n]、听到 [d ɔ]。`o` 判不出类，`n→ɔ` 是货真价实的跨类，
    // 加罚的话两条路同价，回溯从尾巴先试 sub，于是又变回「(缺o) [n→ɔ]」那种摊法。
    expect(show(alignPhonemes(['d', 'o', 'n'], ['d', 'ɔ']))).toBe('d [o>ɔ] (-n)');
  });
});
