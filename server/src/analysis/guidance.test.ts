import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { splitSections, guidanceSections } from './guidance.js';
import type { Note } from '../notes.js';

function note(markdown: string): Note {
  return { id: 'x', title: 'x', triggers: [], words: [], contrasts: [], severity: 'confirmed', markdown, file: 'x.md' };
}

describe('splitSections', () => {
  it('按 ## / ### 切开，正文归到各自的小节下', () => {
    expect(splitSections('## 原理\n\n舌尖抵齿龈。\n\n## 自检法\n\n捏鼻子。')).toEqual([
      { heading: '原理', body: '舌尖抵齿龈。' },
      { heading: '自检法', body: '捏鼻子。' },
    ]);
  });

  it('第一个小标题之前的内容不算小节（那是引言，不是指导）', () => {
    expect(splitSections('这是引言。\n\n## 原理\n\n舌尖。')).toEqual([{ heading: '原理', body: '舌尖。' }]);
  });

  it('# 一级标题不当小节（那是笔记标题）', () => {
    expect(splitSections('# l/n 不分\n\n## 原理\n\n舌尖。').map((s) => s.heading)).toEqual(['原理']);
  });

  it('空小节丢掉，不产出只有标题没内容的条目', () => {
    expect(splitSections('## 空的\n\n## 有内容\n\n正文').map((s) => s.heading)).toEqual(['有内容']);
  });

  it('没有任何小标题 → 空数组，不崩', () => {
    expect(splitSections('就一段话，没有标题。')).toEqual([]);
    expect(splitSections('')).toEqual([]);
  });
});

describe('guidanceSections', () => {
  it('只挑出可执行的那几节，对比训练之类不带进来', () => {
    const md = [
      '## 音标与定位', '/l/ 是边音。',
      '## 常见误区', '会念成 n。',
      '## 原理', '舌尖抵上齿龈，气流从舌头两侧出去。',
      '## 自检法：捏鼻子测试', '捏住鼻子发 l，声音不断就对了。',
      '## 对比训练', 'night / light',
    ].join('\n\n');
    expect(guidanceSections(note(md)).map((s) => s.heading)).toEqual(['原理', '自检法：捏鼻子测试']);
  });

  it('一节都匹配不上 → 空数组，而不是把整篇当成指导', () => {
    // 铺一大段不相干的内容，比老实说"这篇没写具体动作"更糟——用户以为读到了答案。
    expect(guidanceSections(note('## 对比训练\n\nnight / light\n\n## 例词\n\nno / low'))).toEqual([]);
  });

  it('真实笔记里确实抽得出东西——这条是关键词表的活体检查', () => {
    // guidanceSections 靠小标题关键词匹配，而笔记的标题本来就不统一
    // （`## 原理`、`## 自检法：捏鼻子测试（Pinch Test）`、`## 舌头的"胖瘦"（物理阻断法）`）。
    // 关键词表跟真实笔记脱节的话，UI 上"怎么改"会静静地变成一片空白——不报错、不崩，
    // 只是永远没内容。这条拿仓库里真正的笔记跑一遍，防的就是这种无声失效。
    const dir = join(process.cwd(), 'notes');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const md = readFileSync(join(dir, f), 'utf8');
      expect(guidanceSections(note(md)).length, `${f} 抽不出任何"该怎么发"的小节`).toBeGreaterThan(0);
    }
  });

  /**
   * 同一批笔记，把换行换成 CRLF 再跑一遍。
   *
   * **这条是发布前在全新克隆里跑测试才逼出来的。** 本机的 notes/ 是 LF，而别人
   * clone 下来（git 默认 core.autocrlf=true）拿到的是 CRLF。那时 splitSections
   * 只切 \n，每行尾巴挂着 \r，而 JS 正则里 `.` 不匹配 \r —— 于是标题正则末尾那个
   * `$` 永远等不到行尾，**一个小标题都匹配不上**，17 篇笔记全部返回空数组。
   * 界面上「该怎么发」整块消失，不报错、不崩。
   *
   * 上面那条活体检查读的是磁盘上的真文件，所以它在**本机永远是绿的**。
   * 这条把 CRLF 造出来，让同一个失效在本机也会红。
   */
  it('换行是 CRLF 也照样抽得出来——别人 clone 下来拿到的就是 CRLF', () => {
    const dir = join(process.cwd(), 'notes');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const md = readFileSync(join(dir, f), 'utf8').replace(/\r?\n/g, '\r\n');
      expect(md, `${f}：前提是这份内容真的成了 CRLF`).toContain('\r\n');
      expect(guidanceSections(note(md)).length, `${f} 在 CRLF 下抽不出小节`).toBeGreaterThan(0);
    }
  });
});
