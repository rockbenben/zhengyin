import { describe, it, expect } from 'vitest';
import { stripLeadingTitle } from '../components/NoteBody';

// 笔记文件第一行是 `# <标题>`，跟 frontmatter 的 title 是同一句话。调用方已经把标题
// 排在页头上了，正文再来一遍就是重题——而且那个 H1 比外层标题还大，层级是倒的。
describe('stripLeadingTitle', () => {
  it('去掉开头的 H1', () => {
    expect(stripLeadingTitle('# l / n 不分\n\n正文第一段。')).toBe('正文第一段。');
  });

  it('H1 前面有空行也照样去掉', () => {
    expect(stripLeadingTitle('\n\n# 标题\n\n正文。')).toBe('正文。');
  });

  it('只去掉第一个——正文中间的 H1 是内容，不是重题', () => {
    const md = '# 标题\n\n正文。\n\n# 另一节\n\n更多。';
    expect(stripLeadingTitle(md)).toBe('正文。\n\n# 另一节\n\n更多。');
  });

  it('开头不是 H1 就原样返回', () => {
    expect(stripLeadingTitle('## 原理\n\n舌尖。')).toBe('## 原理\n\n舌尖。');
    expect(stripLeadingTitle('直接就是正文。')).toBe('直接就是正文。');
  });

  it('不把 ## 当成 H1 砍掉', () => {
    // 正则若写成 /^#+\s/ 就会连 ## 一起吃掉，那是整节内容没了
    expect(stripLeadingTitle('## 原理\n\n舌尖抵齿龈。')).toContain('## 原理');
  });

  it('# 后面没有内容（形如 "#tag"）不当标题', () => {
    expect(stripLeadingTitle('#hashtag 不是标题\n\n正文。')).toBe('#hashtag 不是标题\n\n正文。');
  });

  it('空串 / 只有一个标题，不崩', () => {
    expect(stripLeadingTitle('')).toBe('');
    expect(stripLeadingTitle('# 只有标题')).toBe('');
  });
});
