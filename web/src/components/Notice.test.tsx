import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Notice from './Notice';

/**
 * 标签的大小写。`.slug` 的疏排大写是全站页眉语言，但它会把**有单位的**标签改错：
 * 分贝的符号就是 dB——「信噪比 34DB」等于改了单位（实测同屏一处对一处错）。
 * labelKeepsCase 走 .slug.nocaps：疏排照旧，transform 关掉。
 */
describe('Notice 标签', () => {
  it('默认走疏排大写', () => {
    const { container } = render(<Notice tone="warn" label="逐音素评测没开" title="x" />);
    expect(container.querySelector('.slug')?.className).toBe('slug');
  });

  it('labelKeepsCase → slug nocaps（CSS 里那条把 text-transform 关掉）', () => {
    const { container } = render(<Notice tone="warn" label="信噪比 34dB" labelKeepsCase title="x" />);
    expect(container.querySelector('.slug')?.className).toBe('slug nocaps');
  });
});
