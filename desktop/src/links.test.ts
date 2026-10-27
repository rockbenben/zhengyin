import { describe, it, expect } from 'vitest';
import { decideLink } from './links.js';

describe('链接去向', () => {
  it('本应用地址留在窗口里', () => {
    expect(decideLink('http://127.0.0.1:30100/word/click', 'http://127.0.0.1:30100')).toEqual({ kind: 'stay' });
  });

  it('http/https 外链交给系统', () => {
    expect(decideLink('https://example.com/', 'http://127.0.0.1:30100')).toEqual({ kind: 'external', url: 'https://example.com/' });
  });

  it('file:、javascript: 一律拒绝；同源相对路径留在应用内', () => {
    expect(decideLink('file:///C:/x', 'http://127.0.0.1:30100')).toEqual({ kind: 'deny' });
    expect(decideLink('javascript:alert(1)', 'http://127.0.0.1:30100')).toEqual({ kind: 'deny' });
    expect(decideLink('/relative', 'http://127.0.0.1:30100')).toEqual({ kind: 'stay' });
  });
});
