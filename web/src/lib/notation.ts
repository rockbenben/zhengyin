import type { Severity } from '../types';
/**
 * IPA 记法。这一对记号对应这个工具的核心区分，不是讲究：
 *
 *   /ˈnaɪt/   音位转写——这个词**是什么**（词典给的目标）
 *   [naɪt]    语音实现——你**实际发出**的那一串（模型转写、参考录音）
 *
 * 两边都用斜线会把"标准"和"你的"混成一类，而那正是这个工具最不该混的两样东西。
 */

/** 音位转写：目标、词典形、单个音位。斜线，不加空格 */
export const phonemic = (ipa: string | string[]): string =>
  `/${Array.isArray(ipa) ? ipa.join('') : ipa}/`;

/** 语音实现：你发出来的、参考录音里的。方括号，不加空格 */
export const phonetic = (ipa: string | string[]): string =>
  `[${Array.isArray(ipa) ? ipa.join('') : ipa}]`;

/**
 * 一处错法写成人话：「把 /ɑ/ 发成了 /æ/」「/k/ 没发出来」「多发了一个 /d/」。
 * 统计页和首页「卡住的地方」共用——抄第二份会漂移，这个仓库在 sure 的 0.5 上
 * 长出过三份拷贝。
 */
export function describeError(
  r: { kind: 'sub' | 'del' | 'ins'; targetIpa: string | null; heardIpa: string | null },
): string {
  if (r.kind === 'sub') return `把 ${phonemic(r.targetIpa ?? '')} 发成了 ${phonemic(r.heardIpa ?? '')}`;
  if (r.kind === 'del') return `${phonemic(r.targetIpa ?? '')} 没发出来`;
  return `多发了一个 ${phonemic(r.heardIpa ?? '')}`;
}

/**
 * 这处错该链到哪个音素页。
 *
 * sub / del 都有目标音，链目标音——那才是他想发对的那个。
 * ins 没有目标音（多发了一个），只能链他实际发出来的那个。
 */
export const errorPhoneme = (
  r: { kind: 'sub' | 'del' | 'ins'; targetIpa: string | null; heardIpa: string | null },
): string | null => (r.kind === 'ins' ? r.heardIpa : r.targetIpa);

/**
 * 一条笔记 trigger 标签写成人话。
 *
 * `matched` 里装的是笔记 frontmatter 的原始标签（`phoneme:n`、`cluster-onset:kl`…），
 * 那是**写笔记的人和分析器之间的约定**，界面上直接印出来等于让用户读内部语法。
 * 同一条教训在首页那张表上已经吃过一次（那一列原来叫「命中」，也是系统的说法）。
 */
export function explainTag(tag: string): string {
  if (tag.startsWith('phoneme:')) return phonemic(tag.slice(8));
  if (tag.startsWith('cluster-onset:')) return `词首的 ${phonemic(tag.slice(14))} 连缀`;
  if (tag.startsWith('cluster-coda:')) return `词尾的 ${phonemic(tag.slice(13))} 连缀`;
  if (tag.startsWith('word:')) return `「${tag.slice(5)}」这个词`;
  // 这张表要盖住服务端 STATIC_TRIGGERS 里的每一个——漏一个就会
  // 把原始标签直接印给用户，而这个函数存在的理由正是不许那样。
  // notation.test.ts 直接读 server/src/notes.ts 比对。
  return {
    'clear-l': '元音前的清 L', 'dark-l': '元音后的暗 L', 'flap-t': '闪音 T',
    'final-voiced': '词尾的浊辅音',
  }[tag] ?? tag;
}

/**
 * 这篇笔记为什么会出现在这个词条页上。
 * 讲词的笔记（word: 范围）单独说——它不是"这个词里正好有某个音"，是专门讲它的。
 */
export function whyMatched(tags: string[]): string {
  const word = tags.find((t) => t.startsWith('word:'));
  if (word) return '这篇专门讲这个词';
  const parts = tags.map(explainTag);
  return parts.length > 0 ? `因为这个词里有 ${parts.join('、')}` : '';
}

/**
 * 笔记档次在界面上叫什么。
 *
 * **只有 confirmed 有标签**：给一份资料盖个「待观察」，等于把它摆成了对你的判定。
 * 收在这儿是因为它在两处渲染（词条页的 NoteHits、笔记详情页的 Tag），
 * 而这个标签**已经改过一次名**（「你确认过的短板」→「录音里反复出现」）——
 * 那种改动最容易只改一处。
 */
export const SEVERITY_LABEL: Partial<Record<Severity, string>> = { confirmed: '录音里反复出现' };

/**
 * 一个词的音标。词典里没有它时说出来，不摆一个空的斜杠。
 *
 * 收在这儿是因为词条页和复习页原来各写了一遍——连表达式都一字不差。
 */
export function wordIpa(w: { found: boolean; ipa: string }): string {
  return w.found ? `/${w.ipa}/` : w.ipa || '词典里没有这个词';
}
