import type Database from 'better-sqlite3';
import { putAttribution } from './db.js';
import { lookupWord, tokenize } from './analysis/lookup.js';
import { attributeTags } from './analysis/features.js';
import { syllabify } from './analysis/syllables.js';
import { explainersFor, type ErrorTags } from './judge.js';
import type { Note } from './notes.js';

/**
 * 把 `attempt_note` 按**当前**的匹配规则重算一遍。
 *
 * 这张表是缓存，不是流水：内容全由（错误行 + 这次念的词 + 当前的 notes/）派生，
 * 判据只有一处（judge.ts 的 `explainersFor`）。启动时和导入后各对一次账，
 * 所以改匹配规则不用写迁移。
 *
 * 它当过流水，代价是判据一改库里就欠账——实测 182 条证据有 39 条站不住，
 * 而没有任何东西会提醒你。
 */

/** 一条错误行在库里的样子 */
interface ErrorRow {
  kind: 'sub' | 'del' | 'ins';
  target_ipa: string | null;
  heard_ipa: string | null;
  at_index: number;
}

/**
 * 从错误行还原 ErrorTags —— judge 里那个 `if (bad)` 分支的逆运算，两边必须一致。
 *
 * `ins` 特殊：多出来的音在目标序列上没有自己的位置，结构标签要取**夹缝两边**，
 * 只看一边的话 click 加塞的那个 /ə/ 谁也够不着。
 */
function toErrorTags(errors: ErrorRow[], perPhone: Array<{ tags: string[] }>): ErrorTags[] {
  const structuralAt = (i: number) => (perPhone[i]?.tags ?? []).filter((t) => !t.startsWith('phoneme:'));
  const out: ErrorTags[] = [];
  for (const e of errors) {
    if (e.kind === 'ins') {
      if (e.heard_ipa === null) continue;
      out.push({
        must: e.heard_ipa,
        better: null,
        structural: [...structuralAt(e.at_index - 1), ...structuralAt(e.at_index)],
      });
      continue;
    }
    if (e.target_ipa === null) continue;
    out.push({
      must: e.target_ipa,
      better: e.kind === 'sub' ? e.heard_ipa : null,
      structural: structuralAt(e.at_index),
    });
  }
  return out;
}

/** 这次录音该挂哪几篇笔记。算不出来（词典查不到那个词了）返回 null，调用方不动它 */
export function attributionOf(
  target: string, errors: ErrorRow[], notes: Note[],
): Set<string> | null {
  const looked = tokenize(target).map((w) => lookupWord(w));
  if (looked.length === 0 || looked.some((p) => !p)) return null;
  const phones = looked.flatMap((p) => p!);
  const perPhone = attributeTags(phones, syllabify(phones));
  return explainersFor(toErrorTags(errors, perPhone), notes, target);
}

export interface Reconciliation {
  /** 看过几次录音 */
  checked: number;
  /** 真改了的：这次录音的归属从什么变成了什么 */
  changed: Array<{ target: string; at: string; added: string[]; removed: string[] }>;
  /** 词典里查不到了、这次没敢动的 */
  skipped: number;
}

export function reconcileAttempts(db: Database.Database, notes: Note[]): Reconciliation {
  const attempts = db.prepare('SELECT id, target, at FROM attempt ORDER BY id').all() as Array<
    { id: number; target: string; at: string }>;
  const errorsBy = new Map<number, ErrorRow[]>();
  for (const e of db.prepare('SELECT * FROM attempt_error').all() as Array<ErrorRow & { attempt_id: number }>) {
    if (!errorsBy.has(e.attempt_id)) errorsBy.set(e.attempt_id, []);
    errorsBy.get(e.attempt_id)!.push(e);
  }
  const notesBy = new Map<number, Set<string>>();
  for (const n of db.prepare('SELECT * FROM attempt_note').all() as Array<
    { attempt_id: number; note_id: string }>) {
    if (!notesBy.has(n.attempt_id)) notesBy.set(n.attempt_id, new Set());
    notesBy.get(n.attempt_id)!.add(n.note_id);
  }

  const changed: Reconciliation['changed'] = [];
  let skipped = 0;

  db.transaction(() => {
    for (const a of attempts) {
      const want = attributionOf(a.target, errorsBy.get(a.id) ?? [], notes);
      if (want === null) { skipped += 1; continue; }
      const have = notesBy.get(a.id) ?? new Set<string>();
      const added = [...want].filter((id) => !have.has(id)).sort();
      const removed = [...have].filter((id) => !want.has(id)).sort();
      // 没变就不写：不然每次启动白改一遍库，报告也会被淹掉
      if (added.length === 0 && removed.length === 0) continue;
      putAttribution(db, a.id, want);
      changed.push({ target: a.target, at: a.at, added, removed });
    }
  })();

  return { checked: attempts.length, changed, skipped };
}
