import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import { validateShape, validateTriggers, type Note, type NoteStore } from '../notes.js';
import { writeFileAtomic } from '../atomic.js';
import { reconcileAttempts } from '../reconcile.js';
import { syncProfile } from '../profile.js';
import { extractJson } from './json.js';

export type NoteDraftScope = 'phoneme' | 'word';

export interface NoteDraft {
  title: string;
  scope: NoteDraftScope;
  values: string[];
  contrasts: string[];
  body: string;
}

export interface AiNotesDeps {
  db: Database.Database;
  noteStore: NoteStore;
  /** 本机笔记目录（data/notes），只有这里可写 */
  localNotes: string;
  profileFile: string;
  now: () => string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** 模型偶尔会把 IPA 写成 `/l/`、`[l]` 或 `phoneme:l`；这里只剥壳，不猜音。 */
const cleanPhoneme = (v: string): string =>
  v.trim().replace(/^phoneme:/i, '').replace(/^[/[]+/, '').replace(/[/\]]+$/, '').trim();

const cleanWord = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ');

const unique = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

/**
 * 把外部输入收成草稿。
 *
 * 模型输出和用户在编辑器里改完的草稿都走这里——两者都是不可信输入，
 * 不能因为其中一条来自自家界面就少校验一次。
 */
function normalizeDraft(input: unknown): NoteDraft {
  if (!isRecord(input)) throw new Error('AI 没有返回 JSON 对象');
  const scope = input.scope === 'phoneme' || input.scope === 'word' ? input.scope : null;
  if (!scope) throw new Error('AI 返回的 scope 只能是 phoneme 或 word');

  const rawValues = Array.isArray(input.values) ? input.values.map(String) : [];
  const values = unique(rawValues.map(scope === 'phoneme' ? cleanPhoneme : cleanWord));
  if (values.length === 0) throw new Error('AI 没有给出适用范围（values）');

  const rawContrasts = Array.isArray(input.contrasts) ? input.contrasts.map(String) : [];
  const contrasts = unique(rawContrasts.map(cleanPhoneme));

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new Error('AI 没有给出正文（body）');

  const title = String(input.title ?? '').trim() || 'AI 笔记';
  return { title, scope, values, contrasts, body };
}

export function parseNoteDraft(raw: string): NoteDraft {
  return normalizeDraft(extractJson(raw));
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

function newNoteId(draft: NoteDraft, deps: AiNotesDeps): string {
  const base = `ai-${draft.scope}-${slug(draft.title) || hash(draft.title)}`;
  const taken = new Set(deps.noteStore.all().map((n) => n.id));
  let id = base;
  let suffix = 2;
  // 本机另一台设备/手工放的笔记可能还没被 watcher 扫到，所以文件存在也算撞。
  while (taken.has(id) || existsSync(join(deps.localNotes, `${id}.md`))) id = `${base}-${suffix++}`;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('生成的笔记 id 不安全');
  return id;
}

/**
 * 把草稿写成一篇本机笔记。
 *
 * frontmatter 由服务端拼，不让模型碰 YAML：`id` 要保证唯一且能当文件名，
 * `triggers` / `words` / `contrasts` 的写法错一个字就会静默匹配不上。
 */
export function saveAiNote(deps: AiNotesDeps, input: NoteDraft): { id: string; title: string; file: string } {
  const draft = normalizeDraft(input);
  const id = newNoteId(draft, deps);
  const triggers = draft.scope === 'phoneme' ? draft.values.map((v) => `phoneme:${v}`) : [];
  const words = draft.scope === 'word' ? draft.values : [];

  const candidate: Note = {
    id, title: draft.title, triggers, contrasts: draft.contrasts, words,
    severity: 'info', markdown: draft.body, file: `${id}.md`, source: 'local',
  };
  const warnings = [...validateTriggers([candidate]), ...validateShape([candidate])];
  if (warnings.length > 0) throw new Error(`笔记没通过校验：\n${warnings.join('\n')}`);

  const frontmatter: Record<string, unknown> = { id, title: draft.title };
  if (triggers.length > 0) frontmatter.triggers = triggers;
  if (words.length > 0) frontmatter.words = words;
  if (draft.contrasts.length > 0) frontmatter.contrasts = draft.contrasts;

  mkdirSync(deps.localNotes, { recursive: true });
  writeFileAtomic(join(deps.localNotes, `${id}.md`), matter.stringify(`${draft.body}\n`, frontmatter));
  deps.noteStore.load();

  // 笔记已经落盘了，下面两样是派生数据：失败只告警，不能把“写成功”报成失败。
  try {
    reconcileAttempts(deps.db, deps.noteStore.all());
  } catch (e) {
    console.warn(`[ai] 笔记写入后重算归属失败：${(e as Error).message}`);
  }
  try {
    syncProfile(deps.profileFile, deps.db, deps.noteStore, deps.now());
  } catch (e) {
    console.warn(`[ai] 笔记写入后同步发音档案失败：${(e as Error).message}`);
  }

  return { id, title: draft.title, file: `${id}.md` };
}
