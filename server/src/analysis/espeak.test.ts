import { describe, it, expect } from 'vitest';
import { collapseStress, normalizeEspeakIpa, normalizeToken } from './espeak.js';
import { IPA, parsePhones } from './phones.js';

// 跟 espeak.ts 里同样的推导方式。**不能**写成 Object.values(IPA)——那样会漏掉
// parsePhones 按重音改写出来的 ə/ɚ，于是这条"总闸"测试会把正确的 ɚ 判成越界，
// 反过来逼着实现去做错误的映射。（这个坑第一版就真踩了。）
const KNOWN = new Set(
  parsePhones(Object.keys(IPA).flatMap((b) => [0, 1, 2].map((st) => `${b}${st}`))).map((p) => p.ipa),
);

// 这一组输入全部是 spike 里 wav2vec2 对 data/audio/ 下真人录音/TTS 的**实测输出**
// 用真实输出而不是手编字符串，
// 是因为这张映射表唯一的用途就是消化这个模型实际会吐的东西。
const REAL: Array<[word: string, raw: string, expected: string[]]> = [
  ['night',  'n aɪ t',      ['n', 'aɪ', 't']],
  ['light',  'l aɪ t',      ['l', 'aɪ', 't']],
  ['click',  'k l ɪ k',     ['k', 'l', 'ɪ', 'k']],
  ['glass',  'ɡ l æ s',     ['ɡ', 'l', 'æ', 's']],
  ['black',  'b l æ k',     ['b', 'l', 'æ', 'k']],
  ['fine',   'f aɪ n',      ['f', 'aɪ', 'n']],
  ['thin',   'θ ɪ n',       ['θ', 'ɪ', 'n']],
  ['thought', 'θ ɔ t',      ['θ', 'ɔ', 't']],
  ['sing',   's ɪ ŋ',       ['s', 'ɪ', 'ŋ']],
  ['ship',   'ʃ ɪ p',       ['ʃ', 'ɪ', 'p']],
  ['yes',    'j ɛ s',       ['j', 'ɛ', 's']],
  ['west',   'w ɛ s t',     ['w', 'ɛ', 's', 't']],
  ['love',   'l ʌ v',       ['l', 'ʌ', 'v']],
  ['judge',  'dʒ ʌ dʒ',     ['dʒ', 'ʌ', 'dʒ']],
  ['name',   'n eɪ m',      ['n', 'eɪ', 'm']],
  ['how',    'h aʊ',        ['h', 'aʊ']],

  // ↓ 下面这些正是不做归一化就会误判的情形
  ['bird',   'b ɜː d',      ['b', 'ɝ', 'd']],          // ɜː → ɝ
  ['church', 'tʃ ɜː tʃ',    ['tʃ', 'ɝ', 'tʃ']],
  ['butter', 'b ʌ ɾ ɚ',     ['b', 'ʌ', 't', 'ɚ']],     // 闪音 ɾ → t（美音里就是对的）
  ['water',  'w ɑː ɾ ɚ',    ['w', 'ɑ', 't', 'ɚ']],     // 长音符去掉 + 闪音
  ['father', 'f ɑː ð ɚ',    ['f', 'ɑ', 'ð', 'ɚ']],
  ['measure', 'm ɛ ʒ ɚ',    ['m', 'ɛ', 'ʒ', 'ɚ']],
  ['red',    'ɹ ɛ d',       ['r', 'ɛ', 'd']],          // eSpeak 的 ɹ → 本项目的 r
  ['boy',    'b oɪ',        ['b', 'ɔɪ']],              // oɪ → ɔɪ
  ['voice',  'v oɪ s',      ['v', 'ɔɪ', 's']],
  ['zoo',    'z ʉ',         ['z', 'u']],
  ['blue',   'b l uː',      ['b', 'l', 'u']],
  ['see',    's i5',        ['s', 'i']],               // 多语种模型带出来的中文声调数字
  ['cup',    'k a p',       ['k', 'æ', 'p']],
  ['cat',    'k eː t',      ['k', 'ɛ', 't']],
  ['this',   'd e s',       ['d', 'ɛ', 's']],
];

/**
 * 不是音素的符号一律剥掉。
 *
 * `.` 是踩出来的：边车实测吐过 `i. t ɛ i`，于是 `i.` 被当成一个音素一路带下去——
 * 匹配不上任何 trigger（`phoneme:i.` 不存在）、在套印带上显示成一个怪字形、
 * 还会作为一个独立"音素"进统计。它是 IPA 的音节分隔符，跟声调数字、重音符同一类。
 */
describe('剥掉不是音素的符号', () => {
  it('音节分隔符 . 不是音素', () => {
    expect(normalizeToken('i.')).toEqual(['i']);
    expect(normalizeEspeakIpa('i. t ɛ i')).toEqual(['i', 't', 'ɛ', 'i']);
  });

  it('连接符 ‿ 不是音素', () => {
    expect(normalizeToken('n‿')).toEqual(['n']);
  });

  it('剥完只剩空的话，不产出空音素', () => {
    expect(normalizeToken('.')).toEqual([]);
    expect(normalizeToken('ˈ')).toEqual([]);
  });

  it('真正的音素不受影响', () => {
    expect(normalizeToken('θ')).toEqual(['θ']);
    expect(normalizeEspeakIpa('n aɪ t')).toEqual(['n', 'aɪ', 't']);
  });
});

describe('normalizeEspeakIpa（输入全是 spike 的真实模型输出）', () => {
  for (const [word, raw, expected] of REAL) {
    it(`${word}: ${raw}`, () => {
      expect(normalizeEspeakIpa(raw)).toEqual(expected);
    });
  }

  it('归一化结果里的每个音素都在本项目的 IPA 集合内', () => {
    // 这条是整张表的总闸：只要有一条映射写歪了、指向一个 phones.ts 里不存在的符号，
    // 下游的音素对齐就会把"念对了"判成"发错了"，而且看上去还挺像回事。
    for (const [word, raw] of REAL) {
      for (const p of normalizeEspeakIpa(raw)) {
        expect(KNOWN.has(p), `${word} 的 ${raw} 归一化出了未知音素 ${p}`).toBe(true);
      }
    }
  });
});

describe('normalizeToken 的边界', () => {
  it('空串 / 纯空白 → 不产出音素', () => {
    expect(normalizeEspeakIpa('')).toEqual([]);
    expect(normalizeEspeakIpa('   ')).toEqual([]);
    expect(normalizeToken('')).toEqual([]);
  });

  it('多余空格不产生空音素', () => {
    expect(normalizeEspeakIpa('  n   aɪ  t  ')).toEqual(['n', 'aɪ', 't']);
  });

  it('喉塞音丢弃，不硬凑成某个辅音', () => {
    expect(normalizeToken('ʔ')).toEqual([]);
    expect(normalizeEspeakIpa('b ʔ t')).toEqual(['b', 't']);
  });

  it('r 化元音+r 拆成两个音素', () => {
    expect(normalizeToken('ɑːɹ')).toEqual(['ɑ', 'r']);
    expect(normalizeToken('ɛɹ')).toEqual(['ɛ', 'r']);
  });

  it('没见过的组合 token 按已知符号切开', () => {
    // aɪə 不在映射表里，但 aɪ 和 ə 都在
    expect(normalizeToken('aɪə')).toEqual(['aɪ', 'ə']);
  });

  it('完全认不出的符号原样保留，不冒充成别的音', () => {
    // 多语种模型词表里有 ɯᵝ（日语）这种东西。硬映射成某个英语音素，会把
    // "模型听到了别的语言的音"伪装成"你把这个音发错成了 X"——那是编造诊断。
    expect(normalizeToken('ɯᵝ')).toEqual(['ɯᵝ']);
  });

  it('长音符不会让同一个元音被判成两个不同的音', () => {
    expect(normalizeToken('ɑː')).toEqual(normalizeToken('ɑ'));
    expect(normalizeToken('uː')).toEqual(normalizeToken('u'));
    expect(normalizeToken('iː')).toEqual(normalizeToken('i'));
  });

  it('aɪ 不会被切成 a + ɪ（长符号必须优先匹配）', () => {
    // 切错的话 night 会变成 n æ ɪ t，跟目标 n aɪ t 对不上，念对了也报错。
    expect(normalizeToken('aɪ')).toEqual(['aɪ']);
    expect(normalizeToken('aʊ')).toEqual(['aʊ']);
    expect(normalizeToken('eɪ')).toEqual(['eɪ']);
  });
});

describe('collapseStress', () => {
  it('ə/ʌ、ɚ/ɝ 归并——模型不输出重音，这个维度没有判据', () => {
    expect(collapseStress(['ə', 'ʌ', 'ɚ', 'ɝ'])).toEqual(['ʌ', 'ʌ', 'ɝ', 'ɝ']);
  });

  it('念对的 water 归并后两侧完全一致（不归并的话会误报两处发音错误）', () => {
    // CMUdict: water = W AO1 T ER0 → w ɔ t ɚ；模型实测输出 `w ɑː ɾ ɚ` → w ɑ t ɚ。
    // 词尾这个 ɚ 两边本来就一样，重音归并不改变它；真正的分歧只在 ɔ/ɑ 这一处，
    // 那是发音差异（cot-caught 合并），不是重音问题，该报就得报。
    const target = collapseStress(['w', 'ɔ', 't', 'ɚ']);
    const heard = collapseStress(normalizeEspeakIpa('w ɑː ɾ ɚ'));
    expect(target[3]).toBe(heard[3]);
    expect(target[0]).toBe(heard[0]);
    expect(target[2]).toBe(heard[2]);
  });

  it('不动其它音素', () => {
    expect(collapseStress(['n', 'aɪ', 't'])).toEqual(['n', 'aɪ', 't']);
    expect(collapseStress([])).toEqual([]);
  });
});
