import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askFirstRun, askLockedDataRoot, validateDataRoot } from './firstRun.js';

describe('旧数据文件夹校验', () => {
  it('含 data/ 或 notes/ 才收', () => {
    const ok = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(ok, 'data'));
    expect(validateDataRoot(ok)).toBeNull();

    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    expect(validateDataRoot(empty)).toMatch(/不像正音/);
  });
});

describe('数据锁恢复', () => {
  it('显示 pid，取消选择和无效目录后仍可重选', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    const dir = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(dir, 'data'));
    const dialog = {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showOpenDialog: vi.fn()
        .mockResolvedValueOnce({ canceled: true, filePaths: [] })
        .mockResolvedValueOnce({ canceled: false, filePaths: [empty] })
        .mockResolvedValueOnce({ canceled: false, filePaths: [dir] }),
    };
    expect(await askLockedDataRoot(dialog, '占用（pid 123）', 'old')).toBe(dir);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: '占用（pid 123）' }));
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('不像正音') }));
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(3);
  });
  it('重试保留当前目录，退出不更改目录', async () => {
    for (const response of [1, 2]) {
      const dialog = { showMessageBox: vi.fn(async () => ({ response })), showOpenDialog: vi.fn() };
      expect(await askLockedDataRoot(dialog, 'pid 123', 'old')).toBe(response === 1 ? 'old' : null);
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    }
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
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('不含发音档案和笔记'),
    }));
  });

  it('全新开始 / 取消 → fresh', async () => {
    const dialog = {
      showMessageBox: vi.fn(async () => ({ response: 2 })),
      showOpenDialog: vi.fn(),
    };
    expect(await askFirstRun(dialog)).toEqual({ kind: 'fresh' });
  });
});
