import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { phonemeStats, overallStats, stuckWords, PHONEME_STATS_LIMIT, type PhonemeStat } from './db.js';
import type { NoteStore, Severity } from './notes.js';
import { localUrl } from './port.js';

// 把评测流水汇总回 发音档案.md。
//
// 为什么要回写成 Markdown 而不是只留在 sqlite 里：AI 读得到的是磁盘上的文本文件，
// 不是同目录那个二进制的 index.db。不落到档案里，下次对话就只能靠用户口述印象，
// 工具测了几十次的结果一条都用不上。
//
// **手写内容绝不能被覆盖**：工具只往自己的标记块里写，块不存在就追加到文件末尾。

export const BEGIN = '<!-- AUTO:发音统计 开始（这一块由工具生成，手改会在下次评测后被覆盖） -->';
export const END = '<!-- AUTO:发音统计 结束 -->';

/**
 * ⚠️ **改这两个字符串要连迁移一起想。**
 *
 * 开发期改过一次界面措辞（「听辨」→「评测」），连标记一起换了，于是新标记跟已有档案
 * 对不上，"标记不成对"的守卫拒绝写入——守卫做对了，但**统计从那一刻起静默停更**，
 * 不看服务端日志根本发现不了。当时的解法是留一张旧标记表，读的时候一并认。
 *
 * 那张表在发布前删掉了：模板里一个标记都没有（块不存在就追加到末尾），
 * 新装的人第一次同步写的就是上面这两个，旧格式在任何一台新机器上都不可能出现。
 * 但**发布之后就不一样了**——用户手里的 `发音档案.md` 是按当时那版标记写的，
 * 再改这两个字符串就是一次真的数据迁移，得重新认旧的。
 */

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function describe(s: PhonemeStat): string {
  if (s.kind === 'sub') return `把 /${s.targetIpa}/ 发成了 /${s.heardIpa}/`;
  if (s.kind === 'del') return `/${s.targetIpa}/ 没发出来`;
  return `多发了一个 /${s.heardIpa}/`;
}

/**
 * 这处错的两个音素，分成**必须讲到的**和**讲到更好的**。
 *
 * - 替换（把 A 念成了 B）：必须讲 A。B 是你念错才得到的音，讲到它说明这篇正好讲这组对立
 * - 漏音（A 没发出来）：只有 A
 * - 多音（多发了一个 B）：只有 B——它没有目标位置，B 就是这处错本身
 */
function involved(s: PhonemeStat): { must: string | null; better: string | null } {
  return s.kind === 'ins'
    ? { must: s.heardIpa, better: null }
    : { must: s.targetIpa, better: s.kind === 'sub' ? s.heardIpa : null };
}

/**
 * 一篇笔记对**这个使用者**算什么档次。
 *
 * **不读 frontmatter。** severity 曾经写在笔记里，那是写笔记的人对读者的断言——
 * 而短板因人而异，别人克隆下来看到的是前一个使用者的判定，对他就是句假话。
 * 所以档次从他自己的评测记录推，没出现过算资料（**全新装上的人全在这一档**）。
 *
 * ── 讲音的和讲词的，门槛不一样 ──
 *
 * 讲音的笔记（`triggers:`）要 **≥MIN_COUNT 次且跨 ≥2 个词**。跨词是"这是个习惯"
 * 和"这一个词的问题"之间最可靠的分界：实测 95 次评测里 74 次都在 `dopamine detox`
 * 一个词上，l-vs-n 在它身上命中 27 次——那更可能是"这个词里那个 /n/ 我老丢"，
 * 而不是"我 l/n 普遍不分"。
 *
 * 讲词的笔记（`words:`）**不要求跨词**：它讲的就是这几个词，没有泛化主张可提，
 * 要求它"不止在一个词上出现"是结构上不可能满足的。实测后果：dopamine 那篇
 * 命中 70 次（全库最高），却顶着素材库那行「还没在你身上出现过，或者出现得还不够」——
 * 那句话是假的。
 *
 * ── 跟 worthANote 的关系 ──
 *
 * 这里**不共用** worthANote 那条。那句"门槛共用一条"曾经写在这儿，而且写下时是真的
 * （e432156，两边都是 count>=3 && words>=2）；22 分钟后 worthANote 加了
 * `soloCount >= MIN_COUNT` 这条 OR 分支（65d1d9a），这边没跟着改，那句话就成了过期断言。
 *
 * 不跟过去也是对的——两者问的不是同一件事：
 *   · soloCount   → 这处错**是真的**，还是转写崩了
 *   · 跨 ≥2 个词  → 这是个**习惯**，还是这一个词的问题
 * 「值不值得写一篇笔记」两种证据任一成立都够，所以 worthANote 该 OR；
 * 而这里贴的标签所在区块问的就是泛化，所以要跨词。
 */
export function severityOf(
  ev: { count: number; words: number } | undefined,
  note: { triggers: string[]; words: string[] },
): Severity {
  if (!ev || ev.count === 0) return 'info';
  if (ev.count < MIN_COUNT) return 'watch';
  // 只声明 words 的笔记＝讲词的。两个都声明就当讲音的：它既然提了音素，就是在主张泛化
  const byWord = note.triggers.length === 0 && note.words.length > 0;
  return byWord || ev.words >= 2 ? 'confirmed' : 'watch';
}

/**
 * 一处错由哪几篇笔记来教：**目标音和错法都要覆盖到，而错法可以走 `contrasts:`。**
 *
 * 两种更简单的判据都试过，坏法正好相反：
 *
 * · **沾上一个就算** → `n→ŋ` 被 l-vs-n 认领（它声明了 phoneme:n，却一个字没提
 *   后鼻音），真问题从「该补的笔记」里消失。
 * · **两边都要写进 triggers** → `θ→s` 时 th-vs-s 挂不上，因为按规矩
 *   「念错了才会得到的那个音，不该当 trigger」，它本就不该声明 phoneme:s。
 *   于是一篇专门讲这个错的笔记，在这个错发生时不出现。
 *
 * 打架是因为 `triggers` 一个字段扛了两份工作。拆出 `contrasts` 之后两边都成立：
 * 它只回答"这处错谁来讲"，不参与词条页匹配——所以 th-vs-s 不会弹在每个含 /s/ 的词上。
 *
 * 漏音和多音只涉及一个音素，`better` 为 null，判据自动退化成"讲到它就算"。
 *
 * **导出**是因为发音档案的统计块和 `/api/stats` 都要问这个问题，而它们一度各答各的。
 */
export function notesCovering<N extends NoteScope>(s: PhonemeStat, notes: N[]): N[] {
  const { must, better } = involved(s);
  return bestExplainers(notes, must, better);
}

/** bestExplainers 只需要笔记的这两个字段 */
interface NoteScope { triggers: string[]; contrasts?: string[] }

/**
 * notesCovering 的内核，按音素直接问。
 *
 * @param must   这处错的目标音（多音时是多出来那个）。null 表示无从判断 → 谁也教不了
 * @param better 你实际发出来的那个音。给了就必须也覆盖到（triggers 或 contrasts 任一）
 */
export function bestExplainers<N extends NoteScope>(
  notes: N[], must: string | null, better: string | null,
): N[] {
  if (must === null) return [];
  return notes.filter((n) =>
    n.triggers.includes(`phoneme:${must}`)
    && (better === null
      || n.triggers.includes(`phoneme:${better}`)
      || (n.contrasts ?? []).includes(better)));
}

/** 「该补的笔记」的次数门槛。那段话自己写着"反复出错"，1 次谈不上反复。 */
const MIN_COUNT = 3;

/**
 * 这条错误值不值得为它写一篇**音素**笔记：次数 ≥MIN_COUNT，**且至少跨两个词**。
 *
 * 第二条更要紧。实测「把 /d/ 发成了 /t/」6 次，看着像清浊对立那个经典问题，
 * 结果 6 次全在 dopamine 一个词上，而那几条转写是 [ħ]、t o x æ m i n（x 英语里没有）
 * ——**转写崩了，不是发音错**。照它写一篇笔记就是凭空造一个不存在的问题。
 * 反过来真问题「/l/→/n/」出现在 click / glass / light 三个词上。
 *
 * 只筛「该补的笔记」这份建议清单，上面那张统计表照旧列全——原始数据不该被观点过滤。
 */
export function worthANote(s: PhonemeStat): boolean {
  if (s.count < MIN_COUNT) return false;
  // 两条独立的证据，任一成立即可：
  //   · 跨词复现——同一个毛病在不同的词上都犯
  //   · 独占整条转写——那几次评测除了它没有别的错，说明模型把其余的音全听对了
  // 只留前一条的话会误伤真信号：/ɑ/→/æ/ 17 次全在 detox 一个词上，
  // 但 15 次整条只错这一个音，是明明白白的真短板，却被"跨几个词"筛掉了。
  // 而 /d/→/t/ 那批同样只在一个词上，转写却是 ħ、t o x æ m i n——两者只有这一条分得开。
  return s.words.length >= 2 || s.soloCount >= MIN_COUNT;
}

export function renderBlock(db: Database.Database, notes: NoteStore, now: string): string {
  const total = overallStats(db);
  const stats = phonemeStats(db);

  if (total.attempts === 0) {
    return [BEGIN, '', '## 发音统计', '', '还没有评测记录。在网页里录一次音就会开始积累。', '', END].join('\n');
  }

  const lines: string[] = [BEGIN, '', '## 发音统计', '',
    `截至 ${now.slice(0, 10)}：共 ${total.attempts} 次评测，涉及 ${total.words} 个词，` +
    `其中 ${total.clean} 次每个音都对上（${Math.round((total.clean / total.attempts) * 100)}%）。`,
    ''];

  if (stats.length === 0) {
    lines.push('目前没有记录到任何音素层面的错误。', '', END);
    return lines.join('\n');
  }

  lines.push('### 最常犯的音素错误', '',
    '| 次数 | 错法 | 例词 | 有没有笔记 |', '|---:|---|---|---|');

  // 有没有对应笔记，是"下一篇该写什么"的直接依据——次数多又没笔记的排在最上面，
  // 一眼就能看出该补哪一课。
  const missing: PhonemeStat[] = [];
  for (const s of stats) {
    const hit = notesCovering(s, notes.all());
    if (hit.length === 0) missing.push(s);
    const noteCell = hit.length > 0
      ? hit.map((n) => `[${n.title}](notes/${n.file})`).join('、')
      : '**还没有**';
    lines.push(`| ${s.count} | ${describe(s)} | ${s.words.join('、')} | ${noteCell} |`);
  }

  const worth = missing.filter(worthANote);
  if (worth.length > 0) {
    lines.push('', '### 该补的笔记', '',
      `下面这些音**反复出错**（≥${MIN_COUNT} 次）、而且**不止在一个词上**出错，` +
      '但 `notes/` 里还没有对应的笔记——问 AI 这几个音怎么发，让它补上：', '');
    for (const s of worth) {
      lines.push(`- ${describe(s)}（${s.count} 次，如 ${s.words.slice(0, 3).join('、')}）`);
    }
    lines.push('', `（进这份清单要么跨 ≥2 个词，要么有 ≥${MIN_COUNT} 次是**整条转写只错这一个音**。`
      + `${MIN_COUNT} 次以下的不在这里逐条列——那个量级还谈不上"反复"。）`);
  }

  // ── 筛掉了什么，**点名说出来** ──
  //
  // 只写规则不写"被筛掉的是谁"，会让一条 17 次的错就那么消失：/ɑ/→/æ/ 全在一个词上，
  // 被判据筛掉，而次数最多的那个错一声不吭。同套印带那条规矩：忽略掉什么要说出来。
  //
  // **必须在上面那个 if 之外**：一条都没通过的时候才最需要说筛掉了什么，
  // 写在里面的话全军覆没那次反而一个字不说。只点名次数够却没通过证据判定的，
  // 次数不够的本来就是噪声。
  const loudButRejected = missing.filter((s) => s.count >= MIN_COUNT && !worthANote(s));
  if (loudButRejected.length > 0) {
    lines.push('', '### 次数够、但暂时没推荐', '',
      '**次数大的不该无声消失**，所以连原因一起写在这里。判据要是错了，从这份名单最看得出来：', '');
    for (const s of loudButRejected) {
      lines.push(`- ${describe(s)}（${s.count} 次）——只在 ${s.words.join('、')} 上出现过，`
        + '而且那几次的转写里多数还有别的错，更像是那次录音的问题');
    }
  }

  // ── 卡住的词：给 AI 的队列里**词级**的那一半 ──
  //
  // 「该补的笔记」是音素级的，回答不了这个：dopamine detox 练了 35 次、全对率 11%，
  // 而它已经挂着三篇讲解——不是缺笔记，是**现有的讲解没起作用**，得人去看。
  // 有没有讲解都列出来，两种情况处理方式不同（没讲解→写一篇；有讲解还错→去看为什么）。
  const stuck = stuckWords(db);
  if (stuck.length > 0) {
    lines.push('', '### 卡住的词', '',
      '练了很多次、还是过不去的词。**有没有讲解都列出来**——没讲解的该写一篇，'
      + '有讲解还在错的说明那篇没起作用，得去看看错的到底是什么：', '');
    for (const w of stuck) {
      const hit = notes.all().filter((n) => n.words.includes(w.text.toLowerCase()));
      const rate = Math.round((w.clean / w.attempts) * 100);
      lines.push(`- **${w.text}** —— 练了 ${w.attempts} 次，全对 ${w.clean} 次（${rate}%）`
        + (hit.length > 0
          ? `。已有讲解：${hit.map((n) => `[${n.title}](notes/${n.file})`).join('、')}`
          : '。**还没有讲这个词的笔记**'));
    }
  }

  // phonemeStats 有个 20 条的上限。真被截断时必须说出来——
  // 一张看着"就这些"的表，底下还藏着没显示的行，是最容易让人误判的一种呈现。
  if (stats.length >= PHONEME_STATS_LIMIT) {
    // 端口不能写死：`.env` 里 PORT 改过之后，写进档案的这条命令就是错的。
    //
    // **两个读者，给两条路。** 这份档案人在读（他自己的记录），AI 也在读（纠音前先看它）。
    // 原来只给 `curl`——那是给 AI 的，而人打开这个文件时更想点一下就看见。
    // 发音统计页就是同一份数据的界面，先给它。
    lines.push('', `（错法种类超过 ${PHONEME_STATS_LIMIT} 种，上表只列了最常犯的那些。`
      + `完整的在发音统计页 ${localUrl()}/stats ，或 \`curl ${localUrl()}/api/stats\`。）`);
  }

  lines.push('', END);
  return lines.join('\n');
}

/**
 * 把统计块写回档案。原子写（临时文件 + rename），中途崩了不会留下半截档案——
 * 这个文件里有大量手写内容，是仓库里最不该被写坏的东西之一。
 */
export function syncProfile(file: string, db: Database.Database, notes: NoteStore, now: string): void {
  const block = renderBlock(db, notes, now);
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';

  // 这里仍然写成"一组标记里挑一个"的形状：将来真要改标记，就是往这个数组里
  // 添回旧的那一对，别的一行不用动（BEGIN/END 上面那段注释讲了为什么会有那一天）。
  const marks = [{ begin: BEGIN, end: END }];
  const hit = marks
    .map((m) => ({
      m,
      begins: countOf(original, m.begin),
      ends: countOf(original, m.end),
      from: original.indexOf(m.begin),
      to: original.indexOf(m.end),
    }))
    .find((x) => x.begins > 0 || x.ends > 0);

  let next: string;
  if (!hit) {
    // 第一次写：追加到末尾，已有内容一个字节都不动
    next = original.trimEnd() + (original.trim() ? '\n\n' : '') + block + '\n';
  } else if (hit.begins === 1 && hit.ends === 1 && hit.to > hit.from) {
    next = original.slice(0, hit.from) + block + original.slice(hit.to + hit.m.end.length);
  } else {
    // 标记不成对（手滑删了一个、或复制粘贴出两份）。**不猜边界**：
    // 只剩一个开始标记时，"补一块到末尾"看着无害，但下一次同步就会 indexOf 到那个旧
    // 标记、而 END 落在新块的尾巴上——中间所有手写内容会被一次性吞掉。
    // 这个文件里全是人写的判断，宁可这次不更新统计，也不能赌。
    throw new Error(
      `发音档案的 AUTO 标记不成对（开始 ${hit.begins} 个、结束 ${hit.ends} 个），` +
      '为免吃掉手写内容这次不写入。把标记补成一对，或者整块删掉让它重新生成。',
    );
  }
  if (next === original) return;

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, next, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 清不掉就算了，别掩盖真正的错误 */ }
    throw e;
  }
}
