import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import PageResult, { LoadFailed } from './PageResult';

describe('整页状态也是一页，得有页头', () => {
  it('标题渲染成 h1', () => {
    const { container } = render(
      <PageResult slug="找不到" title="没有这篇笔记">去笔记列表看看现在有哪些。</PageResult>,
    );
    const h1 = container.querySelectorAll('h1');
    expect(h1.length, '整页一个 h1 都没有').toBe(1);
    expect(h1[0].textContent).toBe('没有这篇笔记');
  });

  it('五个页面共用同一段「读不出来」，只有读的是什么不同', () => {
    const a = render(<LoadFailed what="词条列表" />).container.textContent ?? '';
    const b = render(<LoadFailed what="复习队列" />).container.textContent ?? '';
    expect(a).toContain('没能读出词条列表');
    expect(b).toContain('没能读出复习队列');
    // 除了那个名词，其余一字不差
    expect(a.replace('词条列表', '§')).toBe(b.replace('复习队列', '§'));
  });

  // 换掉 antd Result 的三条理由，任何一条都够：
  //   · status="404" 会摆一张自带的卡通插画（蓝白小人抱纸箱、绿色植物）——
  //     全站再没有第二处插画，而绿色这个色相调色板里根本没有
  //   · status="error" 是个大红叉，而调色板写着「红只给破坏性操作」
  //   · 标题渲染成 <div>，那些页面整页没有 h1
  // 三条都是"看不出坏"的坏法，所以让它会红。
  it('不许再回到 antd 的 Result', () => {
    const root = join(import.meta.dirname, '..');
    const files = ['components', 'pages'].flatMap((d) =>
      readdirSync(join(root, d))
        .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
        .map((f) => join(root, d, f)));
    const guilty = files.filter((f) => /from 'antd'/.test(readFileSync(f, 'utf8'))
      && /\bResult\s*[,}]/.test(readFileSync(f, 'utf8').match(/import \{[^}]*\} from 'antd';/)?.[0] ?? ''));
    expect(guilty.map((f) => f.slice(root.length + 1)), '这些文件又从 antd 引了 Result').toEqual([]);
  });
});
