import type Database from 'better-sqlite3';
import type { EntryRow } from './db.js';
import * as store from './db.js';
import type { NoteStore, Note } from './notes.js';
import { matchNotes } from './analysis/match.js';
import { notesCovering } from './profile.js';

/** 只依赖这两样，app.ts 和 AI 上下文共用同一份「这个词跟哪篇笔记有关」的判据。 */
export interface NoteLinkDeps {
  db: Database.Database;
  noteStore: NoteStore;
}

export function entryHasNote(entry: EntryRow, note: Note): boolean {
  const tags = new Set(entry.words.flatMap((w) => w.tags));
  // 两条路都算：讲音的笔记看 trigger，讲词的笔记看词条本身（见 notes.ts 的 Note.words）
  return note.triggers.some((t) => tags.has(t)) || note.words.includes(entry.text);
}

/**
 * 这个词上「跟你有关」的笔记：笔记 id → 是哪几处错把它拉出来的（`i→aɪ` 这样）。
 * 讲这个词本身的（`words:`）也算，那种不需要你先错一次。
 *
 * 词条页和首页那张表必须数同一个东西；AI 上下文也走这里，不再另写一份。
 */
export function relevantNotes(
  deps: NoteLinkDeps,
  text: string,
  hits: ReturnType<typeof matchNotes>,
): Map<string, string[]> {
  // **只让替换说话**：漏音不指向任何一对音，讲对比的笔记教不了它
  const myErrors = store.errorsOnWord(deps.db, text).filter(
    (e) => e.kind === 'sub' && e.targetIpa !== null,
  );
  const becauseOf = new Map<string, string[]>();
  for (const e of myErrors) {
    for (const n of notesCovering(e, deps.noteStore.all())) {
      const label = `${e.targetIpa}→${e.heardIpa}`;
      const cur = becauseOf.get(n.id) ?? [];
      if (!cur.includes(label)) cur.push(label);
      becauseOf.set(n.id, cur);
    }
  }
  // 讲这个词的笔记：它整篇就是关于这个词的，没有「你还没在这儿错过」这一说
  for (const h of hits) {
    if (h.matched.some((m) => m.startsWith('word:')) && !becauseOf.has(h.note.id)) {
      becauseOf.set(h.note.id, []);
    }
  }
  return becauseOf;
}
