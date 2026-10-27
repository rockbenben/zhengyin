import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic } from './atomic.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'atomic-'));
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('writeFileAtomic', () => {
  it('正常写入不留 tmp', () => {
    const dir = fresh();
    const file = join(dir, 'x.json');
    writeFileAtomic(file, '{"a":1}\n');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('EPERM 重试后成功，且重试了两次', () => {
    const dir = fresh();
    const file = join(dir, 'x.json');
    writeFileSync(file, 'old', 'utf8');
    let calls = 0;
    const rename = vi.fn(((from: string, to: string) => {
      calls += 1;
      if (calls <= 2) throw errno('EPERM');
      renameSync(from, to);
    }) as unknown as typeof renameSync);
    writeFileAtomic(file, 'new', { rename, sleep: () => {} });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('不可重试的错误立刻抛，tmp 被清掉', () => {
    const dir = fresh();
    const file = join(dir, 'x.json');
    const rename = vi.fn((() => { throw errno('EINVAL'); }) as unknown as typeof renameSync);
    expect(() => writeFileAtomic(file, 'x', { rename, sleep: () => {} })).toThrow(/EINVAL/);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
