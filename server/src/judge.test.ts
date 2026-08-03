import { describe, it, expect } from 'vitest';
import { parsePhones } from './analysis/phones.js';
import { judge } from './judge.js';
import type { Note } from './notes.js';

/**
 * 判定这一段原来整个长在 `/api/pronounce` 那个 274 行的路由处理器里，
 * 只能靠 HTTP 测：app.test.ts 里 63 处 `/api/pronounce`，每条都要打桩边车、
 * 造 wav 字节、起一个 app。抽出来之后这里直接喂输入看输出。
 *
 * 抽出来才发现的账：`renameHeard` 和 `bestExplainers` 在此之前
 * **一条单元测试都没有**——而它们各自都对应着一个实测踩过的 bug。
 */
function note(over: Partial<Note>): Note {
  return {
    id: 'n', title: 't', triggers: [], contrasts: [], words: [],
    severity: 'info', markdown: '', file: 'n.md', ...over,
  };
}

/** click /klɪk/ */
const CLICK = parsePhones(['K', 'L', 'IH1', 'K']);
/** about /əˈbaʊt/ —— 首音是轻读的 AH0，词典名是 ə */
const ABOUT = parsePhones(['AH0', 'B', 'AW1', 'T']);

describe('judge：全对的时候什么都不报', () => {
  it('听到的跟词典一模一样 → 没有错、没有标签', () => {
    const r = judge({
      phones: CLICK, heard: ['k', 'l', 'ɪ', 'k'], confs: null, baselineIpa: null, notes: [], target: 'click',
    });
    expect(r.wrong).toEqual([]);
    expect(r.errorTags).toEqual([]);
    expect(r.tags).toEqual([]);
    expect(r.align.every((op) => op.kind === 'match')).toBe(true);
  });

  // match 恒为 sure：CONFIDENT 回答的是"这条断言出来的错可信吗"，
  // 而 match 没有断言任何错。35% 的元音位置低于门槛，真要标的话
  // 念对的词里三分之一的元音都会挂上一个用户什么也做不了的灰标记。
  it('置信度再低，对上的音也算 sure', () => {
    const r = judge({
      phones: CLICK, heard: ['k', 'l', 'ɪ', 'k'], confs: [0.1, 0.1, 0.1, 0.1],
      baselineIpa: null, notes: [], target: 'click',
    });
    expect(r.align.every((op) => op.sure)).toBe(true);
    expect(r.wrong).toEqual([]);
  });
});

describe('judge：一处替换', () => {
  const heard = ['k', 'n', 'ɪ', 'k'];          // click 的 /l/ 念成了 /n/

  it('报出来，而且目标音和听到的音都进标签', () => {
    const r = judge({ phones: CLICK, heard, confs: null, baselineIpa: null, notes: [], target: 'click' });
    expect(r.wrong).toHaveLength(1);
    expect(r.errorTags).toHaveLength(1);
    expect(r.errorTags[0].must).toBe('l');
    expect(r.errorTags[0].better).toBe('n');
    expect(r.tags).toContain('phoneme:l');
    expect(r.tags).toContain('phoneme:n');
  });

  it('模型没把握的错不算数——拿它挂笔记会让档案堆满假问题', () => {
    const r = judge({
      phones: CLICK, heard, confs: [0.9, 0.2, 0.9, 0.9], baselineIpa: null, notes: [], target: 'click',
    });
    expect(r.wrong, '低置信度的错被当真了').toEqual([]);
    expect(r.errorTags).toEqual([]);
  });

  it('结构标签跟着这个位置一起带上——不然讲结构的笔记永远挂不上', () => {
    const r = judge({ phones: CLICK, heard, confs: null, baselineIpa: null, notes: [], target: 'click' });
    // click 的 /l/ 在 onset 连缀里，也是清 L
    expect(r.errorTags[0].structural).toContain('cluster-onset:kl');
    expect(r.errorTags[0].structural).toContain('clear-l');
  });
});

/**
 * ── 改名之后目标==听到：这不是错，是念对了 ──
 *
 * 对齐用参考转写、命名用词典音标，两者在同一格可能不一致（那正是参考基准的理由）。
 * 于是"念的正好等于词典音、但不等于参考转写"会被判成 sub，改名后两边又成了同一个符号。
 * 实测：界面说"你把 /ʊ/ 发成了 /ʊ/"，还建了复习卡——**念对了反被排进复习队列**，
 * 库里攒过 8 条。
 */
describe('judge：参考基准跟词典不一致时，不许把念对的报成错', () => {
  it('念的等于词典音、但不等于参考转写 → 判成 match，不是 sub', () => {
    // 词典 click /k l ɪ k/，而参考转写把 /ɪ/ 听成了 /i/（模型在元音上的系统性偏置）
    const r = judge({
      phones: CLICK, heard: ['k', 'l', 'ɪ', 'k'], confs: null,
      baselineIpa: ['k', 'l', 'i', 'k'], notes: [], target: 'click',
    });
    expect(r.wrong, '按词典念对了，却被参考转写判成错').toEqual([]);
    expect(r.align[2].kind).toBe('match');
  });

  it('ə / ʌ 只差重音，不许沿着一个自己声称测不了的维度报错', () => {
    // about 首音词典是 ə，模型听成 ʌ——两者只差重音，而模型不输出重音
    const r = judge({
      phones: ABOUT, heard: ['ʌ', 'b', 'aʊ', 't'], confs: null, baselineIpa: null, notes: [], target: 'click',
    });
    expect(r.wrong, '报出了「你把 /ə/ 发成了 /ʌ/」').toEqual([]);
    // 而且 match 的两版必须同字，否则套印带会把"念对了"画成重影
    expect(r.align[0]).toMatchObject({ kind: 'match', targetIpa: 'ə', heardIpa: 'ə' });
  });
});

/**
 * ── renameHeard：两侧都要换回未归并的名字 ──
 *
 * 少换听到那一侧的话：click 加塞 /ə/ 会在顶层显示 ə、套印带同屏写 ʌ，
 * phoneme:ə 的笔记从听到侧挂不上，统计永久记成 ʌ。
 */
describe('judge：听到那一侧要换回模型的实际输出', () => {
  it('多出来一个 ə，报的就是 ə 不是归并后的 ʌ', () => {
    // click 念成 kəlick：k 和 l 之间多了一个 ə
    const r = judge({
      phones: CLICK, heard: ['k', 'ə', 'l', 'ɪ', 'k'], confs: null, baselineIpa: null, notes: [], target: 'click',
    });
    const ins = r.align.find((op) => op.kind === 'ins');
    expect(ins, '没报出多余的音').toBeDefined();
    expect((ins as { heardIpa: string }).heardIpa, '被归并成 ʌ 了').toBe('ə');
    expect(r.tags).toContain('phoneme:ə');
  });

  it('多出来的音夹在两个位置之间 → 两边的结构标签都算', () => {
    const r = judge({
      phones: CLICK, heard: ['k', 'ə', 'l', 'ɪ', 'k'], confs: null, baselineIpa: null, notes: [], target: 'click',
    });
    // 那个 ə 落在 k 和 l 之间，两边都不认领的话讲 /kl/ 连缀的笔记就够不着它
    expect(r.errorTags[0].structural).toContain('cluster-onset:kl');
  });
});

/**
 * ── bestExplainers：替换错要两边都覆盖到 ──
 *
 * 只沾上一个就算的话，`n→ŋ` 会被只讲 /n/ 的 l-vs-n 冒领——而那篇一个字没提后鼻音，
 * 于是真问题从「该补的笔记」里消失了（实测出现 9 次）。
 */
describe('judge：这处错谁教得了', () => {
  const lvn = note({ id: 'l-vs-n', triggers: ['phoneme:l', 'phoneme:n'] });
  const nvng = note({ id: 'n-vs-ng', triggers: ['phoneme:n', 'phoneme:ŋ'] });

  it('n→ŋ 只该由讲后鼻音的那篇认领，l-vs-n 冒领不了', () => {
    const thin = parsePhones(['TH', 'IH1', 'N']);
    const r = judge({
      phones: thin, heard: ['θ', 'ɪ', 'ŋ'], confs: null, baselineIpa: null, notes: [lvn, nvng], target: 'thin',
    });
    expect([...r.noteIds]).toContain('n-vs-ng');
    expect([...r.noteIds], 'l-vs-n 一个字没提后鼻音，却把这处错认领了').not.toContain('l-vs-n');
  });

  it('错法写在 contrasts 里也算——那篇专门讲这个错，不能在它发生时挂不上', () => {
    // θ→s：th-vs-s 只声明 phoneme:θ（s 是错法，不该当 trigger），错法走 contrasts
    const thin = parsePhones(['TH', 'IH1', 'N']);
    const ths = note({ id: 'th-vs-s', triggers: ['phoneme:θ'], contrasts: ['s'] });
    const r = judge({
      phones: thin, heard: ['s', 'ɪ', 'n'], confs: null, baselineIpa: null, notes: [ths], target: 'thin',
    });
    expect([...r.noteIds], 'θ→s 发生时，专门讲它的那篇没挂上').toContain('th-vs-s');
  });

  it('讲结构的笔记走"沾上一个就算"——那类笔记讲的就是结构本身，不成对', () => {
    const kl = note({ id: 'kl-cluster', triggers: ['cluster-onset:kl'] });
    const r = judge({
      phones: CLICK, heard: ['k', 'ə', 'l', 'ɪ', 'k'], confs: null, baselineIpa: null, notes: [kl], target: 'click',
    });
    expect([...r.noteIds]).toContain('kl-cluster');
  });
});

/**
 * ── 逐处错单独匹配，不能把所有错的标签拍平成一个池子 ──
 *
 * 拍平之后任何笔记沾上池子里任意一个标签就算命中：一篇讲 A 和 B 的笔记，
 * 在"某处错涉及 A、另一处错涉及 B"时会被当成命中，而没有哪一处错同时涉及两者。
 */
describe('judge：两处错各算各的，不许合成一个池子', () => {
  it('一篇讲 A/B 的笔记，不该因为 A 和 B 分别出现在两处错里就被认领', () => {
    // thin /θ ɪ n/ 念成 /s ɪ ŋ/：两处错，θ→s 和 n→ŋ
    const thin = parsePhones(['TH', 'IH1', 'N']);
    // 一篇同时声明 s 和 n 的笔记——没有哪一处错同时涉及这两个
    const bogus = note({ id: 'bogus', triggers: ['phoneme:s', 'phoneme:n'] });
    const r = judge({
      phones: thin, heard: ['s', 'ɪ', 'ŋ'], confs: null, baselineIpa: null, notes: [bogus], target: 'thin',
    });
    expect(r.errorTags, '两处错应该各占一条').toHaveLength(2);
    expect([...r.noteIds], '把两处错的标签拍平之后被冒领了').not.toContain('bogus');
  });
});
