import { describe, it, expect } from 'vitest';
import { isNoise, isWrong, isUnsureMiss, gradeOf } from './align';
import type { AlignOp } from '../types';

// 测的是真实现（lib/align.ts，OverprintStrip 用的就是它）。
// 上一版在测试文件里自己复制了一份 isSure/isNoise 来测——真实现漂移了它照样绿。
//
// 门槛语义（含边界、缺 conf 当确定、del 与 match 恒确定）由 server/src/app.test.ts 钉住，
// 那里的用例 mock 的是 CONFIDENT 本身而不是字面量。这里只钉分类规则本身。

describe('杂音与真加塞元音要分开', () => {
  it('拿不准的多余音算杂音', () => {
    // 使用者的原始反馈：念了个 /k/，界面在它前面多列一个拿不准的 /t/。
    // 塞音爆破只有 20–30ms，模型必然拿不准——那不是一个音。
    expect(isNoise({ kind: 'ins', heardIpa: 't', conf: 0.28, sure: false })).toBe(true);
  });

  it('有把握的多余元音【不是】杂音——那是真的加塞，是已确认短板', () => {
    // click → "克-里-克"。/ə/ 是持续的浊音段，模型有把握。
    // 跟杂音一起吞掉的话，这个工具就测不出使用者最典型的错误之一了。
    expect(isNoise({ kind: 'ins', heardIpa: 'ə', conf: 0.71, sure: true })).toBe(false);
  });

  it('替换和缺失即使拿不准也不算杂音', () => {
    // 那两种的**位置是真的**（对齐把它钉住了），只是身份不确定，值得摆出来。
    // 而多余音连"那儿到底有没有一个音"都不确定。
    expect(isNoise({ kind: 'sub', targetIpa: 'ɔ', heardIpa: 'ɑ', conf: 0.31, sure: false })).toBe(false);
    expect(isNoise({ kind: 'del', targetIpa: 'l', sure: true })).toBe(false);
  });

  it('对上的音不算杂音', () => {
    // 只造服务端真能吐出来的状态：match 恒为 sure（见 app.ts 算 sure 那一段），
    // 所以不写 {match, sure:false} —— 那会教给读者一个服务端明确拒绝的不变量。
    expect(isNoise({ kind: 'match', targetIpa: 'k', heardIpa: 'k', conf: 0.3, sure: true })).toBe(false);
  });
});

/**
 * 第三种状态：模型听到了别的音，但自己没把握。
 *
 * 加它是因为之前只有两态——「确凿的错」和「其余都算对」——于是
 * thin [θ ɪ n] → [f ɛ n] 被判成「每个音都发对了」。实测 47 次评测里 6 次判全对，
 * **5 次是这么来的**，只有 1 次是真的每个音都对上。
 */
describe('isUnsureMiss', () => {
  it('拿不准的替换和缺失算——那是"这个音是什么"没测准', () => {
    expect(isUnsureMiss({ kind: 'sub', targetIpa: 'θ', heardIpa: 'f', sure: false })).toBe(true);
    expect(isUnsureMiss({ kind: 'del', targetIpa: 'n', sure: false })).toBe(true);
  });

  it('拿不准的**多余音**不算——那是杂音，跟 isNoise 同一条分工', () => {
    // 多余音的不确定是"那儿到底有没有音"。把它算进来的话，一声气流就能
    // 把一次好录音判成"没测准"。
    expect(isUnsureMiss({ kind: 'ins', heardIpa: 'ə', sure: false })).toBe(false);
  });

  it('有把握的错不算——那是确凿的错，走 isWrong 那条路', () => {
    // 两条谓词不许重叠：一处错要么是"确凿的错"要么是"没测准"，不能既是又是。
    const confidentSub = { kind: 'sub' as const, targetIpa: 'θ', heardIpa: 'f', sure: true };
    expect(isUnsureMiss(confidentSub)).toBe(false);
    expect(isWrong(confidentSub)).toBe(true);
  });

  it('对上的音永远不算', () => {
    expect(isUnsureMiss({ kind: 'match', targetIpa: 'n', heardIpa: 'n', sure: true })).toBe(false);
  });
});

/**
 * 复习的自动打分。**四种结局里三种都是"不计入进度"**——这一页的原则是宁可不计、也不猜。
 * 抽成纯函数之前它藏在 ReviewPage 的闭包里，那一页没有测试。
 */
describe('gradeOf', () => {
  const op = (o: Partial<AlignOp> & { kind: AlignOp['kind'] }) => o as AlignOp;
  const result = (align: AlignOp[], heardIpa = ['x']) =>
    ({ align, heardIpa } as unknown as Parameters<typeof gradeOf>[0]);

  it('每个音都对上 → 推远一档', () => {
    const v = gradeOf(result([op({ kind: 'match', targetIpa: 'n', heardIpa: 'n', sure: true })]));
    expect(v.grade).toBe('remembered');
  });

  it('有确凿的错 → 打回最短间隔', () => {
    const v = gradeOf(result([op({ kind: 'sub', targetIpa: 'θ', heardIpa: 'f', sure: true })]));
    expect(v.grade).toBe('forgot');
  });

  it('**有拿不准的错 → 不计入进度**，不是当成记住了', () => {
    // 这一条是核心：之前「没有确凿的错」直接当「对」，于是
    // thin [θ ɪ n] → [f ɛ n]（两处都没把握）被判 remembered、把卡片推远一档。
    const v = gradeOf(result([
      op({ kind: 'match', targetIpa: 'n', heardIpa: 'n', sure: true }),
      op({ kind: 'sub', targetIpa: 'θ', heardIpa: 'f', sure: false }),
    ]));
    expect(v.grade).toBeNull();
    expect(v.tone).toBe('unknown');
  });

  it('拿不准的多余音不影响——那是杂音', () => {
    const v = gradeOf(result([
      op({ kind: 'match', targetIpa: 'n', heardIpa: 'n', sure: true }),
      op({ kind: 'ins', heardIpa: 'ə', sure: false }),
    ]));
    expect(v.grade).toBe('remembered');
  });

  it('没听出音 / 没结果 → 不计入进度', () => {
    expect(gradeOf(result([], [])).grade).toBeNull();   // heardIpa 为空
    expect(gradeOf(null).grade).toBeNull();             // 压根没测出来
  });
});
