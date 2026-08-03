import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import OverprintStrip from './OverprintStrip';
import type { AlignOp } from '../types';

/**
 * 套印带是这个工具的签名元素，而它**只在评测出结果之后才渲染**——
 * 平时在浏览器里根本够不着，所以它出问题最不容易被发现。
 */

const ops: AlignOp[] = [
  { kind: 'match', targetIpa: 'k', heardIpa: 'k', sure: true },
  { kind: 'sub', targetIpa: 'l', heardIpa: 'n', sure: true },
  { kind: 'del', targetIpa: 'ɪ', sure: true },
  { kind: 'ins', heardIpa: 'ə', sure: true },
];

function ticks() {
  const { container } = render(<OverprintStrip align={ops} />);
  return [...container.querySelectorAll('.op-seg')].map((seg) => ({
    state: seg.getAttribute('data-state'),
    tick: seg.querySelector('.op-tick')!,
  }));
}

describe('标异常，不标常态', () => {
  it('发对的音不再在视觉上挂一个「对」', () => {
    // "对"这件事已经被说了三遍：两版重合的黑字本身、上面的图例「重合就是发对了」、
    // 下面那句「每个音都发对了」。标注重复到第四遍，只会把真正有事的那一格淹掉。
    const m = ticks().find((t) => t.state === 'match')!;
    expect(m.tick.className).toContain('sr-only');
  });

  it('但语义上留着——屏幕阅读器没有"看见重合"这回事', () => {
    const m = ticks().find((t) => t.state === 'match')!;
    expect(m.tick.textContent).toBe('对');
  });

  it('出错的那几格照常标出来，不能一起藏掉', () => {
    // 反面：把 sr-only 无差别加到所有格上的话，整条带子就一句话都不说了
    for (const state of ['sub', 'del', 'ins']) {
      const t = ticks().find((x) => x.state === state)!;
      expect(t.tick.className, `${state} 的小注被藏起来了`).not.toContain('sr-only');
      expect(t.tick.textContent!.length).toBeGreaterThan(0);
    }
  });
});

/**
 * 调色板里 slot 那一行写着：「空槽的虚线。**只用于线，不用于文字**（对比度不够读）」。
 * 实测 1.96:1，任何文字对比度标准都过不了。
 *
 * 这条规则被违反过：「拿不准」那格的小注（写的是"你发成了什么"，正是要读的信息）
 * 用 slot 上色，而它正上方的字形早就照规则用了 quiet，理由还写在注释里。
 *
 * 所以这里守的不是那一行，是**整份样式表**：slot 只许出现在 border / background /
 * 描边色里，不许当 color。
 */
// vitest 的 cwd 是仓库根还是 workspace 根取决于怎么调起来的，别赌它——按本文件定位
const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css');

describe('slot 只画线，不写字', () => {
  it('styles.css 里没有一处把 slot 当文字色', () => {
    const css = readFileSync(STYLES, 'utf8');
    const offenders: string[] = [];
    for (const line of css.split('\n')) {
      // 注释行不算——文档里提到它是正常的
      const code = line.split('/*')[0];
      if (/(^|[^-\w])color\s*:\s*var\(--slot\)/.test(code)) offenders.push(line.trim());
    }
    expect(offenders, `这几行把 slot 当文字色用了：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('border-color / background 用 slot 是允许的，别把守卫写成一刀切', () => {
    // 空槽那道虚线本来就该用它——这条用例确认上面的正则不会误伤
    const css = readFileSync(STYLES, 'utf8');
    expect(css).toMatch(/border(-\w+)?(-color)?\s*:[^;]*var\(--slot\)/);
  });
});
