import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import NoteBody, { stripLeadingTitle } from './NoteBody';

/**
 * 笔记正文的渲染。
 *
 * 加这个文件是因为模拟新用户走一遍时撞出来的一个既有 bug：**表格整块糊成一行管道符**。
 * react-markdown 裸用只吃 CommonMark，而表格是 GFM 扩展。6 篇笔记里有 5 篇用表格，
 * 砸的正好是信息密度最高的那几段——minimal pairs 对照、错法对照、词尾连缀一览。
 * 点进 desk 第一屏就是那团管道符，而**类型检查和纯函数测试都看不出来**。
 */
describe('NoteBody', () => {
  it('渲染 GFM 表格，不是原样吐管道符', () => {
    const md = [
      '| 词 | 音标 |',
      '|---|---|',
      '| box | /bɑks/ |',
      '| desk | /dɛsk/ |',
    ].join('\n');
    const { container } = render(<NoteBody markdown={md} />);

    // 结构：真的成了表
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    // 内容：单元格里是干净的值
    const cells = [...container.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toContain('box');
    expect(cells).toContain('/bɑks/');
    // 反面：不许还剩下表格语法的痕迹
    expect(container.textContent).not.toContain('|---|');
    expect(container.textContent).not.toContain('| box |');
  });

  it('表格外面要包一层可横向滚动的容器', () => {
    // 对照表列多的时候，横滚必须发生在表自己身上；不包的话窄窗口下整个页面跟着横滚。
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<NoteBody markdown={md} />);
    const wrap = container.querySelector('.table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector('table')).not.toBeNull();
  });

  it('普通正文照常渲染', () => {
    const { container } = render(<NoteBody markdown={'## 自检法\n\n捏住鼻子念 **light**。'} />);
    expect(container.querySelector('h2')?.textContent).toBe('自检法');
    expect(container.querySelector('strong')?.textContent).toBe('light');
  });

  it('砍掉开头那个跟标题重复的 H1，正文中间的 H1 不动', () => {
    expect(stripLeadingTitle('# 标题\n\n正文')).toBe('正文');
    expect(stripLeadingTitle('正文\n\n# 中间的标题')).toContain('# 中间的标题');
  });
});
