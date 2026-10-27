import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import * as store from '../db.js';
import type { NoteStore } from '../notes.js';
import { matchNotes } from '../analysis/match.js';
import { tokenize } from '../analysis/lookup.js';
import { articulationTable, howToPronounce } from '../analysis/articulation.js';
import { relevantNotes } from '../noteLinks.js';

/**
 * 发给 AI 的全部资料。`sources` 是**真的被塞进上下文**的那几篇笔记，
 * 路由原样返回给界面——用户要能看见这次讲解建立在哪些内容上。
 */
export interface AiContext {
  text: string;
  sources: Array<{ id: string; title: string }>;
}

export interface AiContextDeps {
  db: Database.Database;
  noteStore: NoteStore;
  profileFile: string;
  /** 测试用；默认直接读磁盘 */
  readFile?: (path: string) => string;
}

/** 档案只截一段：它包含 AUTO 统计块，通常比正文长；整份塞进去只会挤掉别的资料。 */
const PROFILE_LIMIT = 8000;
/** 每篇相关笔记的正文上限。讲原理的笔记本来就短，超出的多半是练习清单。 */
const NOTE_LIMIT = 3000;
const CHAT_NOTE_LIMIT = 2500;

function profileText(deps: AiContextDeps): string {
  try {
    const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    return read(deps.profileFile).slice(0, PROFILE_LIMIT);
  } catch {
    // 文件不存在只说明这台机器还没跑过服务，不是错误；AI 拿到空档案即可。
    return '';
  }
}

const side = (ipa: string | null): string => ipa ?? '∅';

function describeError(e: { kind: string; targetIpa: string | null; heardIpa: string | null; atIndex: number }): string {
  return `${e.kind} ${side(e.targetIpa)}→${side(e.heardIpa)} @${e.atIndex}`;
}

function describeStat(s: store.PhonemeStat): string {
  return `${s.kind} ${side(s.targetIpa)}→${side(s.heardIpa)} ${s.count} 次（${s.words.join('、')}）`;
}

/**
 * 讲解一个词要用的上下文。
 *
 * `target` 是**这次实际录的是哪个词**：短语词条（black cat）的两次录音可能一次录
 * black、一次录 cat，取最近一次时必须按它过滤，否则会把另一个词的错当成这次的。
 */
export function buildWordContext(deps: AiContextDeps, word: string, target?: string): AiContext {
  const entry = store.getEntry(deps.db, word);
  if (!entry) {
    return { text: `词库里没有「${word}」。先在首页查一次词、把它建成词条，再让 AI 讲解。`, sources: [] };
  }

  const attempt = store.latestAttemptFor(deps.db, word, target?.trim().toLowerCase());
  const errors = attempt?.errors ?? [];
  const allNotes = deps.noteStore.all();
  const hits = matchNotes([...new Set(entry.words.flatMap((w) => w.tags))], allNotes, entry.text);
  const related = relevantNotes(deps, word, hits);
  const notes = allNotes.filter((n) => related.has(n.id)).slice(0, 3);
  const stats = store.phonemeStats(deps.db, 12).slice(0, 8);

  const wordLine = entry.words
    .map((w) => (w.found ? `${w.word} /${w.ipa}/（音素 ${w.phoneIpa.join(' ')}）` : `${w.word}（词典里没有）`))
    .join('；');
  const attemptLine = attempt
    ? `目标 ${attempt.targetIpa.join(' ')}，听到 ${attempt.heardIpa.join(' ')}；错：${errors.map(describeError).join('，') || '无'}`
    : '这个词还没有录音。';
  const errorPhones = [...new Set(errors.flatMap((e) => [e.targetIpa, e.heardIpa]).filter((p): p is string => !!p))];

  const lines = [
    `# 发音档案\n${profileText(deps) || '（没有档案）'}`,
    `# 词条\n${entry.text}：${wordLine}`,
    `# 最近一次录音\n${attemptLine}`,
    `# 高频错误（全部词）\n${stats.map(describeStat).join('\n') || '还没有录音记录。'}`,
    `# 相关笔记\n${notes.map((n) => `## ${n.title}（${n.id}）\n${n.markdown.slice(0, NOTE_LIMIT)}`).join('\n\n') || '（没有匹配的笔记）'}`,
    `# 错误音素的发音要点\n${errorPhones.map((p) => `${p}：${howToPronounce(p) ?? '暂无'}`).join('\n') || '（这次没有需要解释的音素）'}`,
  ];

  return { text: lines.join('\n\n'), sources: notes.map((n) => ({ id: n.id, title: n.title })) };
}

/** 消息里能认出哪些音素。走发音表而不是 IPA 码表：ə/ɚ/ɝ 不在后者里。 */
const IPA_SYMBOLS = articulationTable().map((a) => a.ipa);

export function buildChatContext(deps: AiContextDeps, message: string): AiContext {
  const allNotes = deps.noteStore.all();
  const stats = store.phonemeStats(deps.db, 10);
  const words = [...new Set(tokenize(message).filter((w) => store.getEntry(deps.db, w)))];
  const mentioned = IPA_SYMBOLS.filter((s) => message.includes(s));
  const candidates = allNotes.filter((n) =>
    n.triggers.some((t) => mentioned.some((s) => t === `phoneme:${s}`))
    || n.words.some((w) => words.includes(w)));
  const notes = candidates.slice(0, 3);

  const wordBlocks = words.map((w) => {
    const entry = store.getEntry(deps.db, w)!;
    const errors = store.errorsOnWord(deps.db, w).slice(0, 5).map(describeStat).join('，');
    return `${w} /${entry.words.map((x) => x.ipa).join(' ')}/：${errors || '这个词还没错过'}`;
  });

  const text = [
    `# 发音档案\n${profileText(deps) || '（没有档案）'}`,
    `# 最近的高频错误\n${stats.map(describeStat).join('\n') || '还没有录音记录。'}`,
    `# 消息里提到的词\n${wordBlocks.join('\n') || '（没有库里已有的词）'}`,
    `# 笔记索引\n${allNotes.map((n) => `- ${n.title}（${n.id}）`).join('\n') || '（还没有笔记）'}`,
    `# 可能相关的笔记\n${notes.map((n) => `## ${n.title}（${n.id}）\n${n.markdown.slice(0, CHAT_NOTE_LIMIT)}`).join('\n\n') || '（没有匹配的笔记）'}`,
  ].join('\n\n');

  return { text, sources: notes.map((n) => ({ id: n.id, title: n.title })) };
}

export interface AgentPromptDeps extends AiContextDeps {
  appRoot: string;
  workflowsDir: string;
  userName: string;
}

/**
 * 整理代理的起手提示。
 *
 * 只描述**允许动什么**，具体判断规则在 `workflows/agent.md`——那份文件也是
 * 用户能读、能改的正本，提示词里再抄一遍就会跟它分叉。
 */
export function buildAgentPrompt(deps: AgentPromptDeps, task: string, note?: string): string {
  const localNotes = join(deps.appRoot, 'data', 'notes');
  const reference = join(deps.appRoot, '.ai-reference');
  return [
    `你在为正音做一次「AI 整理」。当前用户：${deps.userName}。`,
    `先读 ${join(deps.workflowsDir, 'agent.md')}，再读它的参考副本 ${join(reference, 'agent.md')}。`,
    `可用：当前用户档案 ${deps.profileFile}、本机笔记 ${localNotes}、参考笔记 ${join(reference, 'notes')}。`,
    '只允许写本机笔记，以及当前用户档案的「已确认的习惯问题」「待观察」两节；不要改 AUTO 统计块，不要动词条库、录音记录、复习进度。',
    `任务：${task}${note ? `\n补充要求：${note}` : ''}`,
  ].join('\n\n');
}
