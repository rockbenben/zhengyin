import type { Phone } from './analysis/phones.js';
import { syllabify } from './analysis/syllables.js';
import { attributeTags } from './analysis/features.js';
import { alignPhonemes, renameTargets, renameHeard, type AlignOp } from './analysis/diff.js';
import { collapseStress, CONFIDENT } from './analysis/espeak.js';
import { bestExplainers } from './profile.js';
import type { Note } from './notes.js';

/**
 * 一次评测的**判定**：从「词典音素 + 模型听到的音素」算到「哪几处错、哪几篇教得了」。
 *
 * ── 为什么抽成一个纯函数 ──
 *
 * 这段逻辑原来整个长在 `/api/pronounce` 那个路由处理器里，那一个 handler 274 行。
 * 后果是它**只能靠 HTTP 测**：app.test.ts 里 63 处 `/api/pronounce`，每条都要
 * 打桩 recognizePhonemes、造 wav 字节、起一个 app。而中间这段本身是纯计算，
 * 给定输入就有确定输出。
 *
 * 这个仓库为同一个理由抽过 `gradeOf`（lib/align.ts）：
 * 「抽成纯函数是因为它原来藏在 ReviewPage 的一个闭包里——那一页没有测试，
 * 于是"把没测准当成记住了"这种改动一路绿灯。规则本身也该只有一个家。」
 * 这里的账更大：`renameHeard` 和 `bestExplainers` 在抽出来之前**一条单元测试都没有**。
 *
 * 留在外面的是真正带副作用的三件：取参考基准（要读音频、调边车）、
 * 查笔记档次（要读库）、落盘。它们不属于"判定"。
 */

/**
 * 判定过的一步。**从 AlignOp 派生**，不另抄一份联合类型——
 * `(A | B) & {sure}` 在 TS 里会分配成 `(A & {sure}) | (B & {sure})`，
 * 判别式还在，而 diff.ts 那边加删一个变体这里自动跟上。
 *
 * sure = 模型对这一步有把握。**只由服务端算**（门槛见 espeak.ts 的 CONFIDENT）——
 * 它在前端有过三份拷贝。
 */
export type JudgedOp = AlignOp & { sure: boolean };

/** 一处错要找讲解时问的三件事 */
export interface ErrorTags {
  /** 目标音（词典那一侧）。ins 没有目标音，这里放听到的那个 */
  must: string | null;
  /** 念成了什么。只有 sub 有 */
  better: string | null;
  /** 这个位置上的结构标签（cluster-onset / cluster-coda / clear-l / dark-l / flap-t / final-voiced） */
  structural: string[];
}

export interface Judgement {
  /** 逐音素对齐结果，已带 sure */
  align: JudgedOp[];
  /** 其中**模型有把握**的错 */
  wrong: JudgedOp[];
  /** 逐处错各自的标签。**按错分组，不能拍平**（理由见 errorTags 那段注释） */
  errorTags: ErrorTags[];
  /** 拍平版，只为兼容 matchNotes 的签名 */
  tags: string[];
  /** 这次该挂哪几篇笔记。见 explainersFor */
  noteIds: Set<string>;
}

/**
 * 一次录音的**证据归属**：这几处错，哪几篇笔记教得了。
 *
 * 全应用只有这一处判据。三个地方要用同一个答案，而它们的输入来源完全不同：
 *   · 评测当场（judge）—— 从对齐结果来
 *   · 对账（reconcile）—— 从库里的错误行来，规则改了要能重算
 *   · 界面上「录音里反复出现」—— 数的就是这张表
 * 所以它只认 ErrorTags，不认 AlignOp，也不碰数据库。
 *
 * 三条路：
 *   1. 音素——目标音和错法都要覆盖到（profile.ts 的 bestExplainers，判据在那儿）
 *   2. 结构——沾上一个标签就算。那类笔记讲的就是结构本身，不成对
 *   3. 按词——`words:` 声明了这个词的笔记。**必须真的错了**：
 *      念对了也挂的话，"你练过这个词"就被当成了"你错过这个音"，
 *      而这张表是「这篇笔记讲的毛病你身上真有」的唯一证据来源
 *
 * errorTags 只在真出错时才有条目（judge 里那个 `if (bad)`），所以第 3 条的
 * "真的错了"就是它非空。
 */
export function explainersFor(errorTags: ErrorTags[], notes: Note[], target: string): Set<string> {
  if (errorTags.length === 0) return new Set();
  const ids = new Set(errorTags.flatMap((e) => [
    ...bestExplainers(notes, e.must, e.better).map((n) => n.id),
    ...notes.filter((n) => e.structural.some((t) => n.triggers.includes(t))).map((n) => n.id),
  ]));
  const key = target.trim().toLowerCase();
  for (const n of notes) if (n.words.includes(key)) ids.add(n.id);
  return ids;
}

export function judge(args: {
  /** 词典查出来的音素（未归并重音） */
  phones: Phone[];
  /** 模型听到的音素，已归一化 */
  heard: string[];
  /** 逐音素置信度，跟 heard 同长；模型没给就是 null */
  confs: number[] | null;
  /** 参考基准（真人录音过同一个模型的转写）。拿不到就传 null，退回词典 */
  baselineIpa: string[] | null;
  notes: Note[];
  /** 这次实际念的词。按词声明范围的笔记（words:）按它匹配 */
  target: string;
}): Judgement {
  const { phones, heard, confs, baselineIpa, notes, target } = args;

  // 归并只影响「判不判错」，不影响「错叫什么」。
  // dictNames 是词典原名（ə/ɚ 保留）——归并只该影响判定，不该影响命名。
  const dictNames = phones.map((p) => p.ipa);
  const dictIpa = collapseStress(dictNames);

  const align0 = alignPhonemes(baselineIpa ?? dictIpa, collapseStress(heard), confs ?? undefined);

  // ── 归并只影响「判不判错」，不影响「错叫什么」。**两侧都要换回未归并的名字** ──
  //
  // 目标侧换回词典名，听到侧换回模型实际输出。少换任何一侧，界面、音素条、
  // 笔记匹配、统计就会各说各的：只换目标侧时，click 加塞 /ə/ 会在顶层显示 ə、
  // 套印带同屏写 ʌ，phoneme:ə 的笔记从听到侧挂不上，统计永久记成 ʌ。
  //
  // 两个 rename 都只认长度相等；collapseStress 逐位映射、保长度，所以成立。
  const named = renameHeard(renameTargets(align0, dictNames), heard);

  const align = named.map((op) => {
    // sure 只由服务端算（门槛见 espeak.ts 的 CONFIDENT）——它在前端有过三份拷贝。
    //
    // ── match 恒为 sure：**只有"错"需要置信度** ──
    //
    // CONFIDENT 回答的是"这条断言出来的错可信吗"。match 没有断言任何错，
    // 只是没找到错的证据；把低置信度当成"可能错了"是把举证责任反过来。
    // 而 35% 的元音位置低于门槛，真要标的话，念对的词里三分之一的元音都会挂上
    // 一个用户什么也做不了的灰标记。
    const sure = op.kind === 'match' || op.kind === 'del' || (op.conf ?? 1) >= CONFIDENT;
    // match 的两版必须同字。对齐判定 match 只可能是"归并后相等"，所以两侧不同字
    // 有且仅有一种情况：一侧 ə/ɚ、另一侧 ʌ/ɝ——正是已经决定不评判的重音对立。
    // 保留两个符号的话，套印带会把「念对了」画成重影（about 念对实测 黑=ə 蓝=ʌ）。
    // 模型的原始输出没有丢：顶层 heardIpa 和 rawIpa 都完整带着。
    if (op.kind === 'match') return { ...op, heardIpa: op.targetIpa, sure };

    // ── 改名之后目标==听到：这不是错，是**念对了** ──
    //
    // 对齐用参考转写、命名用词典音标，两者在同一格可能不一致（那正是参考基准的
    // 理由）。于是"念的正好等于词典音、但不等于参考转写"会被判成 sub，改名后
    // 两边又成了同一个符号。实测：界面说"你把 /ʊ/ 发成了 /ʊ/"，还建了复习卡——
    // 念对了反被排进复习队列，是这个工具最坏的一种误报（库里攒过 8 条）。
    //
    // **比的是归并之后**：ə/ʌ、ɚ/ɝ 只差重音，而模型不输出重音、这个工具也明写着
    // 不评判那个维度。字面比会报出「你把 /ə/ 发成了 /ʌ/」——沿着一个自己声称
    // 测不了的维度报错。del/ins 缺一侧，永远不相等，所以只有 sub 会走到这里。
    if (op.kind === 'sub'
      && collapseStress([op.targetIpa])[0] === collapseStress([op.heardIpa])[0]) {
      return { kind: 'match' as const, targetIpa: op.targetIpa, heardIpa: op.targetIpa, conf: op.conf, sure };
    }
    return { ...op, sure };
  });

  // 挂笔记：目标音和听到的音都算数——把 /n/ 发成 /l/，l-vs-n 那篇笔记两边都该命中。
  // 只有**模型有把握**的错才算数（op.sure，del 恒为 true——"这个音没出现"谈不上把握
  // 程度）。低置信度的"错"多半是模型自己拿不准（实测 water 的 ɑ=0.31、cat 的 eː=0.33
  // 都是这种），拿它去挂笔记、进统计，只会让档案里堆满假问题。
  const wrong = align.filter((op) => op.kind !== 'match' && op.sure);

  // ── 结构性标签也要带上，不能只有 phoneme: ──
  //
  // 只给音素标签的话，靠结构声明范围的笔记（cluster-onset/coda、clear-l、
  // dark-l、flap-t、final-voiced）在评测结果里永远挂不上：click 加塞 /ə/ 测得出来，
  // 而解释它的那篇笔记不出现。词条页一直是对的，漏的只有"该怎么改"这一块。
  //
  // AlignOp 不带位置索引，按顺序推：match/sub/del 各消耗一个目标音，ins 不消耗。
  const perPhone = attributeTags(phones, syllabify(phones));

  // ── 逐处错单独匹配，**不能把所有错的标签拍平成一个池子** ──
  //
  // 拍平之后任何笔记沾上池子里任意一个标签就算命中：一篇讲 A 和 B 的笔记，
  // 在"某处错涉及 A、另一处错涉及 B"时会被当成命中，而没有哪一处错同时涉及两者。
  // dopamine 有 7 处错，池子大到几乎什么都能沾上。
  //
  // 替换错要**两边都覆盖到**（n→ŋ 曾被只讲 /n/ 的 l-vs-n 冒领）；结构标签
  // 走"沾上一个就算"，那类笔记讲的就是结构本身、不成对。
  // 音素这一路交给 profile.ts 的 bestExplainers，判据只留一处。
  const errorTags: ErrorTags[] = [];
  let ti = 0;
  for (const op of align) {
    const bad = wrong.includes(op);
    if (op.kind === 'ins') {
      // 多出来的音在目标序列上没有自己的位置，它夹在 ti-1 和 ti 之间——
      // 两边的结构标签都算，否则 click 的 /ə/ 落在 k 和 l 中间就谁也够不着。
      if (bad) {
        errorTags.push({
          must: op.heardIpa, better: null,
          structural: [...(perPhone[ti - 1]?.tags ?? []), ...(perPhone[ti]?.tags ?? [])]
            .filter((t) => !t.startsWith('phoneme:')),
        });
      }
      continue;
    }
    if (bad) {
      const own = perPhone[ti]?.tags ?? [];
      errorTags.push({
        // 目标音取**词典**那一侧（perPhone 是按词典音素算的），不取 op.targetIpa：
        // 参考基准跟词典长度不等时 renameTargets 会原样退回，那时 op.targetIpa
        // 还是模型内部的符号，而笔记的 trigger 说的是词典 IPA。
        must: own.find((t) => t.startsWith('phoneme:'))?.slice('phoneme:'.length) ?? null,
        better: op.kind === 'sub' ? op.heardIpa : null,
        structural: own.filter((t) => !t.startsWith('phoneme:')),
      });
    }
    ti++;
  }

  // 拍平只是为了兼容 matchNotes 的签名（它还要走 words: 那一路）；
  // 真正的筛选按 errorTags 逐处做。
  const tags = errorTags.flatMap((e) => [
    ...(e.must !== null ? [`phoneme:${e.must}`] : []),
    ...(e.better !== null ? [`phoneme:${e.better}`] : []),
    ...e.structural,
  ]);

  return { align, wrong, errorTags, tags, noteIds: explainersFor(errorTags, notes, target) };
}
