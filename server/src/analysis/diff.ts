import type { Phone } from './phones.js';
import { phonemeClass } from './articulation.js';

export interface PhonemeSub { targetIpa: string; heardIpa: string }

/**
 * ── 对齐的代价表 ──
 *
 * 被钉住的是这条不等式，不是这三个数：
 *
 *     SAME < CROSS ≤ GAP*2
 *
 * 左边让同类替换在同价时赢过跨类；右边保证一对一的跨类错法不会被拆成一删一增
 * （回溯先试 sub，取等号时 sub 仍然赢）。CROSS 取 3 还是 4 行为完全一样，
 * 所以不去钉具体数值——那只会挡住以后按实测重调。
 *
 * **左边为什么必要**：纯 Levenshtein 里 sub 和 del 同价，回溯从尾巴往回走、
 * 先试 sub，于是词尾吞音一律被摊成两条假错误：
 *
 *     目标 θ ɪ n   听到 θ i
 *     θ (缺ɪ) [n→i]   ← 漏了元音 + 把 /n/ 发成了 /i/（都不是真的）
 *     θ [ɪ→i] (缺n)   ← 实际是词尾 /n/ 没收
 *
 * 而这些会写进 attempt_error、堆进发音档案，最后要求补根本不存在的毛病的笔记。
 * 判据是：跨类替换（元音↔辅音）几乎都是没对齐上，同类替换才是真错法
 * （l→n、ɑ→æ、n→ŋ 全是同类）。
 *
 * **右边为什么必要**：辅音元音化是真实错法，暗 L 念成 /ʊ/（milk → "miuk"）
 * 就是中文母语者的典型问题，该报成一处替换而不是拆成一删一增。
 *
 * 查不到的符号判不出类，按同类算——没有判据就不加罚。参考基准本身也是模型转写，
 * 里面同样会有认不出的符号，硬罚一格会把它推去当漏音。
 */
const SAME = 2;   // 同类替换
const CROSS = 3;  // 跨类替换：元音↔辅音
const GAP = 2;    // 漏一个 / 多一个

function subCost(x: string, y: string): number {
  if (x === y) return 0;
  const cx = phonemeClass(x);
  const cy = phonemeClass(y);
  return cx !== null && cy !== null && cx !== cy ? CROSS : SAME;
}

/**
 * 一步对齐结果。音素级评测要能说清三种错法，只报替换是不够的：
 * - sub  你把这个音发成了另一个音
 * - del  这个音**没发出来**（辅音连缀里漏掉一个、词尾吞掉，中文母语者的高频问题）
 * - ins  多发了一个音（"克-里-克"式在辅音之间加塞元音，正是 kl 笔记讲的那件事）
 */
export type AlignOp =
  | { kind: 'match'; targetIpa: string; heardIpa: string; conf?: number }
  | { kind: 'sub'; targetIpa: string; heardIpa: string; conf?: number }
  | { kind: 'del'; targetIpa: string }
  | { kind: 'ins'; heardIpa: string; conf?: number };

/**
 * Levenshtein 对齐 + 回溯，给出完整的逐步操作序列。
 *
 * heardConf 可选，给了就把对应位置的置信度挂到引用了「听到侧」的那些 op 上。
 * del 没有 conf——它说的是"这个音**没出现**"，而置信度描述的是某个实际识别出来的音有多确定，
 * 一个不存在的音谈不上把握程度。
 */
export function alignPhonemes(target: string[], heard: string[], heardConf?: number[]): AlignOp[] {
  const { d, a, b } = table(target, heard);
  const conf = (j: number) => (heardConf ? { conf: heardConf[j - 1] } : {});
  const ops: AlignOp[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      ops.unshift({ kind: 'match', targetIpa: a[i - 1], heardIpa: b[j - 1], ...conf(j) }); i--; j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1])) {
      ops.unshift({ kind: 'sub', targetIpa: a[i - 1], heardIpa: b[j - 1], ...conf(j) }); i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + GAP) {
      ops.unshift({ kind: 'del', targetIpa: a[i - 1] }); i--;
    } else {
      ops.unshift({ kind: 'ins', heardIpa: b[j - 1], ...conf(j) }); j--;
    }
  }
  return ops;
}

function table(a: string[], b: string[]) {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j * GAP : j === 0 ? i * GAP : 0)));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + GAP, d[i][j - 1] + GAP,
        d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]),
      );
  return { d, a, b };
}

/**
 * 只要替换对（漏音/多音不算替换）。
 *
 * 这里**不再自己跑一遍 DP**：它曾经是 alignPhonemes 的一份复制粘贴，两份各有一张
 * 代价表。上面那半格如果只加在一处，两条路径就会对同一段录音给出不同的错法——
 * 而这个仓库反复栽在同一件事上（CONFIDENT 门槛一度有四份拷贝）。判据只留一处。
 */
export function phonemeSubs(target: Phone[], heard: Phone[]): PhonemeSub[] {
  return alignPhonemes(target.map((p) => p.ipa), heard.map((p) => p.ipa))
    .filter((o) => o.kind === 'sub')
    .map((o) => ({ targetIpa: o.targetIpa, heardIpa: o.heardIpa }));
}

/**
 * 把对齐结果里的 targetIpa 换成另一套命名。
 *
 * 用途：声学比对的基准是**参考录音的模型转写**，但报错时要用**词典的音标**说话——
 * 不然界面上会甩出模型内部的符号（"你把 /æ/ 发成了 /ʊ/"，而 book 的目标本来就是 /ʊ/，
 * 那句话是胡说）。两个序列等长时按位置一一对应即可，这是实测 30/30 成立的前提。
 *
 * names 必须跟当初对齐用的 target 序列等长；不等长时原样返回，绝不错位命名。
 */
export function renameTargets(ops: AlignOp[], names: string[]): AlignOp[] {
  const consumed = ops.filter((o) => o.kind !== 'ins').length;
  if (consumed !== names.length) return ops;
  let i = 0;
  return ops.map((o) => (o.kind === 'ins' ? o : { ...o, targetIpa: names[i++] }));
}

/**
 * renameTargets 的镜像：把 heardIpa 换成另一套命名。
 *
 * **为什么必须有它**：对齐是在重音归并之后做的（ə→ʌ、ɚ→ɝ，因为模型不输出重音、
 * 那个维度没有判据）。归并只该影响「判不判错」，不该影响「错叫什么」——目标侧靠
 * renameTargets 换回词典原名，而听到侧一度就地留着归并名，于是：
 *   · 界面顶层的「你发出来的」显示 ə（未归并），套印带同一屏却写 ʌ
 *   · tag 变成 phoneme:ʌ，phoneme:ə 的笔记永远从听到侧挂不上
 *   · 统计和发音档案永久记成 ʌ
 * click 加塞 /ə/（使用者的招牌错误）实测复现了以上全部三条。
 *
 * del 不消耗听到侧的位置（"这个音没发出来"），所以跳过它。
 * names 必须跟当初对齐用的 heard 序列等长；不等长时原样返回，绝不错位命名。
 */
export function renameHeard(ops: AlignOp[], names: string[]): AlignOp[] {
  const consumed = ops.filter((o) => o.kind !== 'del').length;
  if (consumed !== names.length) return ops;
  let i = 0;
  return ops.map((o) => (o.kind === 'del' ? o : { ...o, heardIpa: names[i++] }));
}
