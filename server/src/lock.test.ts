import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDataLock, DataLockBusyError } from './lock.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'lock-'));

describe('数据目录锁', () => {
  it('拿到锁之后写 pid，release 之后可以重新拿', () => {
    const dir = fresh();
    const a = acquireDataLock(dir, { pid: 111, host: 'h', alive: () => true });
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(111);
    a.release();
    const b = acquireDataLock(dir, { pid: 222, host: 'h', alive: () => true });
    b.release();
  });

  it('同一个目录、活着的进程 → 明确拒绝，并说清是谁', () => {
    const dir = fresh();
    acquireDataLock(dir, { pid: 111, host: 'h', alive: () => true });
    expect(() => acquireDataLock(dir, { pid: 222, host: 'h', alive: () => true }))
      .toThrow(DataLockBusyError);
    try { acquireDataLock(dir, { pid: 222, host: 'h', alive: () => true }); }
    catch (e) { expect((e as DataLockBusyError).pid).toBe(111); }
  });

  it('进程不在了就是残锁，接管', () => {
    const dir = fresh();
    acquireDataLock(dir, { pid: 111, host: 'h', alive: () => true });
    const b = acquireDataLock(dir, { pid: 222, host: 'h', alive: () => false });
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(222);
    b.release();
  });

  it('锁文件坏了也接管，不让人手删', () => {
    const dir = fresh();
    writeFileSync(join(dir, '.lock'), '{not json');
    const a = acquireDataLock(dir, { pid: 333, host: 'h', alive: () => true });
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(333);
    a.release();
  });

  it('release 幂等', () => {
    const dir = fresh();
    const a = acquireDataLock(dir, { pid: 1, host: 'h', alive: () => true });
    a.release();
    a.release();
  });
});
