import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUpdater, loadAutoCheck, saveAutoCheck, shouldEnableUpdater } from './updater.js';

it('自动检查默认关，写入后可读回', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'upd-')), 'update-prefs.json');
  expect(loadAutoCheck(file)).toBe(false);
  saveAutoCheck(file, true);
  expect(loadAutoCheck(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('true');
});

it('只有打包的 Windows NSIS 才接更新器', () => {
  expect(shouldEnableUpdater({ isPackaged: true, platform: 'win32', channel: 'nsis' })).toBe(true);
  expect(shouldEnableUpdater({ isPackaged: false, platform: 'win32', channel: 'nsis' })).toBe(false);
  expect(shouldEnableUpdater({ isPackaged: true, platform: 'win32', channel: 'zip' })).toBe(false);
  expect(shouldEnableUpdater({ isPackaged: true, platform: 'darwin', channel: 'nsis' })).toBe(false);
});

it('下载完成后进入 ready，并能拿到版本号', () => {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const au = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: (event: string, cb: (...a: unknown[]) => void) => { handlers.set(event, cb); },
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
  };
  const u = createUpdater(au, {
    log: () => {},
    balloon: () => {},
    showError: () => {},
    setTimer: () => 0,
    readAutoCheck: () => false,
    writeAutoCheck: () => {},
    onChange: () => {},
  });
  handlers.get('update-downloaded')?.({ version: '1.1.0' });
  expect(u.state()).toBe('ready');
  expect(u.versionReady()).toBe('1.1.0');
});
