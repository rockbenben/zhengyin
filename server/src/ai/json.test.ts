import { describe, expect, it } from 'vitest';
import { extractJson } from './json.js';

describe('extractJson', () => {
  it('原样对象', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('三反引号围栏', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前后有闲话', () => {
    expect(extractJson('好的，草稿如下：\n{"a":1}\n以上。')).toEqual({ a: 1 });
  });

  it('拆掉单键包装', () => {
    expect(extractJson('{"note":{"title":"x"}}')).toEqual({ title: 'x' });
    expect(extractJson('```json\n{"draft": {"scope": "word"}}\n```')).toEqual({ scope: 'word' });
  });

  it('没有 JSON 时明确报错', () => {
    expect(() => extractJson('我已经写好了。')).toThrow(/没有 JSON/);
  });

  it('JSON 本身坏了也明确报错', () => {
    expect(() => extractJson('{"a": }')).toThrow(/JSON 解析失败/);
  });
});
