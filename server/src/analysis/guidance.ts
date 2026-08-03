import type { Note } from '../notes.js';

// 从笔记里抽出"这个音到底该怎么发"的部分，好在评测报错的旁边直接给出可执行的动作，
// 而不是只丢一个"撞上已知短板"的链接让人自己去点、去找。
//
// 为什么抽而不是整篇塞过去：一篇笔记还有常见误区、对比训练、阶段拆解这些内容，都有用，
// 但在"你刚把 /n/ 发成了 /l/"这个当口，人要的是**下一秒该怎么动舌头**。整篇铺开会把那
// 两句话淹掉。
//
// 知识仍然只有 notes/ 一处来源——这里只做筛选，不写任何发音知识。笔记没写的，
// 这里也变不出来；那种情况如实说"还没有这个音的笔记"。

// 小标题里出现这些词，就算"可执行的发音指导"。
// 用关键词而不是固定标题名，是因为现有笔记的标题本来就不统一（`## 原理`、
// `## 自检法：捏鼻子测试（Pinch Test）`、`## 舌头的"胖瘦"（物理阻断法）`），
// CLAUDE.md 的模板也只规定顺序不规定字面。硬编标题名会在下一篇笔记就失效。
const ACTIONABLE = ['原理', '自检', '舌', '口型', '气流', '物理', '发音'];

export interface Section { heading: string; body: string }

/**
 * 按 ## / ### 切成小节。正文开头（第一个小标题之前）的内容不算小节。
 *
 * **切行要认 CRLF**：别人 clone 下来的 .md 是 CRLF，而 JS 正则里 `.` 不匹配 `\r`，
 * 只切 `\n` 的话一个标题都匹配不上、整篇返回空。测试里有一条专门跑 CRLF。
 */
export function splitSections(markdown: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^#{2,3}\s+(.*)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { heading: m[1].trim(), body: '' };
    } else if (cur) {
      cur.body += `${line}\n`;
    }
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.trim() })).filter((s) => s.body.length > 0);
}

/**
 * 笔记里可执行的那几节。一节都匹配不上时返回**空数组**而不是整篇——
 * 调用方据此显示"这篇笔记里没写具体怎么发"，比铺一大段不相干的内容诚实。
 */
export function guidanceSections(note: Note): Section[] {
  return splitSections(note.markdown).filter((s) => ACTIONABLE.some((k) => s.heading.includes(k)));
}
