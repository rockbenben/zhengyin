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

/**
 * 「能装」和「看起来能装」得是同一个判据。
 *
 * 更新下好之后用户再点一次「检查更新」，状态机就被推离了 'ready'
 * （检查失败 → 'error'，没有新版本 → 'idle'），而下好的版本一直都在。
 * 这时候界面还摆着「重启以完成更新」，点了却什么都不发生——用户只剩一条死路。
 */
describe('状态漂了也还能把下好的更新装上', () => {
  function setup() {
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
    return { handlers, au, u };
  }

  it('下好之后再点一次检查更新、那次失败了 → 仍然装得上', () => {
    const { handlers, au, u } = setup();
    handlers.get('update-downloaded')?.({ version: '1.1.0' });
    expect(u.state()).toBe('ready');

    // 用户又点了一次「检查更新」，这次检查报错
    u.checkManual();
    expect(u.state()).toBe('checking');
    handlers.get('error')?.(new Error('连不上'));
    expect(u.state()).toBe('error');

    u.restartToInstall();
    expect(au.quitAndInstall).toHaveBeenCalled();
  });

  it('还没下好的时候不装', () => {
    const { au, u } = setup();
    u.restartToInstall();
    expect(au.quitAndInstall).not.toHaveBeenCalled();
  });
});
