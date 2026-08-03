import type { AlignOp, Grade, PronounceResult } from '../types';

/** 「模型自己拿不准」在界面上的叫法，只此一处——散在多处改一个另一个就对不上 */
export const UNSURE = '不确定';

/**
 * 这一步算不算「确凿的错」：不是 match，而且模型有把握。
 *
 * 门槛本身在服务端（结论已经放进 op.sure）。这里只固定这个复合判断，**前端只此一份**——
 * 它一度在 Recorder 和 ReviewPage 各写一遍，改其中一处会让复习页判「每个音都对」
 * 而同一段录音的摘要报有错误，且编译不报错。
 * 服务端另有一份（app.ts），跨包合不了，由 app.test.ts 盯着。
 */
export function isWrong(op: AlignOp): boolean {
  return op.kind !== 'match' && op.sure;
}

/**
 * 这一处是杂音，不是发音问题。
 *
 * 「多出来的音」两个来源的置信度特征正好相反：真的加塞元音（click → 克-里-克）是
 * 50–100ms 的浊音段，模型有把握；塞音爆破带出来的杂音只有 20–30ms，必然拿不准。
 * 参考录音上实测 30/30 从不产生多余音，所以拿不准的多余音几乎只能是杂音。
 *
 * 替换和缺失不套这条：那两种的**位置是真的**，只是身份不确定，值得摆出来让人自己判断。
 */
export function isNoise(op: AlignOp): boolean {
  return op.kind === 'ins' && !op.sure;
}

/**
 * 这一步是「模型听到了别的音，但自己没把握」。
 *
 * **第三种状态。** 之前只有两种：确凿的错 / 其余都算对——于是
 * `thin [θ ɪ n] → [f ɛ n]` 被判成「每个音都发对了」，因为 θ→f 和 ɪ→ɛ
 * 两处的置信度都没过门槛，整条就"没有错"了。实测 47 次评测里 6 次判全对，
 * **5 次是这么来的**，只有 1 次是真的每个音都对上。
 *
 * 「没有确凿的错」不等于「对」。它等于**这次没测准**——那既不该记成全对、
 * 也不该拿去推进复习进度，正确的反应是让人再念一遍。
 *
 * 多余音不算：拿不准的多余音几乎只能是杂音（见 isNoise），那是"那儿有没有音"
 * 的不确定，不是"那个音是什么"的不确定。
 */
export function isUnsureMiss(op: AlignOp): boolean {
  return op.kind !== 'match' && !op.sure && !isNoise(op);
}

/** 复习卡这一次该判成什么。grade 为 null = 测不出来，**不计入进度** */
export interface Verdict { grade: Grade | null; text: string; tone: 'ok' | 'bad' | 'unknown' }

/**
 * 复习的自动打分。
 *
 * **抽成纯函数**是因为它原来藏在 ReviewPage 的一个闭包里——那一页没有测试，
 * 于是"把没测准当成记住了"这种改动一路绿灯。规则本身也该只有一个家。
 *
 * 三种结局，其中两种是「不计入进度」——原则是**宁可不计，也不猜**：
 *   1. 有确凿的错            → forgot
 *   2. 没结果 / 没听出音 / **有拿不准的错** → null，让人再念一遍
 *   3. 每个音都对上          → remembered
 *
 * 第 2 类里"有拿不准的错"是后补的：之前「没有确凿的错」直接当成了「对」，
 * 于是 thin [θ ɪ n] → [f ɛ n] 判成 remembered、把卡片推远一档。
 *
 * **没有"自己点不会"这一档了**：那是复习页还在藏答案时的逃生口。现在标准音、
 * 音标、音素条一进卡就摆着，"不会"无从谈起——不想练这张就跳过，而跳过是
 * 没录音，没录音就不该有分数（跟"测不出来不打分"是同一条）。
 */
export function gradeOf(judged: PronounceResult | null): Verdict {
  if (!judged) return { grade: null, text: '这次测不出来，不计入进度', tone: 'unknown' };
  if (judged.heardIpa.length === 0) return { grade: null, text: '没听出音，不计入进度。再录一次', tone: 'unknown' };

  const wrong = judged.align.filter(isWrong);
  if (wrong.length > 0) {
    return { grade: 'forgot', text: `${wrong.length} 处发音不对，下次还会尽快再练这个`, tone: 'bad' };
  }
  const unsure = judged.align.filter(isUnsureMiss);
  if (unsure.length > 0) {
    return { grade: null, text: `有 ${unsure.length} 处模型没把握，这次不计入进度。再念一遍`, tone: 'unknown' };
  }
  return { grade: 'remembered', text: '每个音都对，下次复习推远一档', tone: 'ok' };
}
