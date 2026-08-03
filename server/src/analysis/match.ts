import type { Note } from '../notes.js';

export interface NoteHit { note: Note; matched: string[] }

const ORDER = { confirmed: 0, watch: 1, info: 2 } as const;

/**
 * 把一批标签（和可选的词条本身）匹配到笔记。
 *
 * 两条独立的匹配路径，对应笔记的两种范围（见 notes.ts 的 Note.words）：
 *   · triggers 命中 tags  → 这是一节关于某个音的课，含这个音的词都该看到
 *   · words 含这个词条    → 这是这个词自己的问题，只在它的页面出现
 *
 * word 不传时只走 triggers 那一路——比如按"听错成了什么音"反查笔记（/api/asr），
 * 那里根本没有"当前词条"这个概念。
 */
export function matchNotes(tags: string[], notes: Note[], word?: string): NoteHit[] {
  const set = new Set(tags);
  const key = word?.trim().toLowerCase();
  return notes
    .map((note) => ({
      note,
      matched: [
        ...note.triggers.filter((t) => set.has(t)),
        // 词命中时也记一条 matched，否则下面的 length > 0 会把它滤掉。
        // 前缀跟 trigger 词表区分开，界面据此知道"这条是因为词、不是因为某个音"命中的。
        ...(key && note.words.includes(key) ? [`word:${key}`] : []),
      ],
    }))
    .filter((h) => h.matched.length > 0)
    .sort((a, b) =>
      // 按词命中的排最前：那是**这个词自己的坑**，不是"这个词里碰巧有这个音"
      Number(b.matched.some((m) => m.startsWith('word:')))
        - Number(a.matched.some((m) => m.startsWith('word:')))
      || ORDER[a.note.severity] - ORDER[b.note.severity]
      || a.note.title.localeCompare(b.note.title, 'zh'),
    );
}
