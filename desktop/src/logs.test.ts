import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogSink } from './logs.js';

describe('LogSink', () => {
  it('落盘、保留尾部、超限滚动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const file = join(dir, 'server.log');
    const s = new LogSink(file, 200);
    s.write('a'.repeat(150));
    s.write('b'.repeat(150));
    expect(s.tail(2).join('')).toContain('b');
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    expect(existsSync(`${file}.1`)).toBe(true);
  });

  it('按行切、尾部只留最近若干行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const s = new LogSink(join(dir, 'x.log'));
    s.write('1\n2\n3\n');
    expect(s.tail(2)).toEqual(['2', '3']);
  });
});
