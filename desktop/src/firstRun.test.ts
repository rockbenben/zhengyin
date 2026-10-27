import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askFirstRun, validateDataRoot } from './firstRun.js';

describe('旧数据文件夹校验', () => {
  it('含 data/ 或 notes/ 才收', () => {
    const ok = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(ok, 'data'));
    expect(validateDataRoot(ok)).toBeNull();

    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    expect(validateDataRoot(empty)).toMatch(/不像正音/);
  });
});

describe('首启选择', () => {
  it('选旧文件夹 → existing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(dir, 'data'));
    const dialog = {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [dir] })),
    };
    expect(await askFirstRun(dialog)).toEqual({ kind: 'existing', dir });
  });

  it('导入备份 → backup', async () => {
    const dialog = {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['C:/b.json'] })),
    };
    expect(await askFirstRun(dialog)).toEqual({ kind: 'backup', file: 'C:/b.json' });
  });

  it('全新开始 / 取消 → fresh', async () => {
    const dialog = {
      showMessageBox: vi.fn(async () => ({ response: 2 })),
      showOpenDialog: vi.fn(),
    };
    expect(await askFirstRun(dialog)).toEqual({ kind: 'fresh' });
  });
});
