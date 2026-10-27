import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type UpdateChannel = 'nsis' | 'zip';

export function updateChannelFromPackage(pkg: { zhengyinChannel?: string }): UpdateChannel {
  return pkg.zhengyinChannel === 'zip' ? 'zip' : 'nsis';
}

/** 只有打包的 Windows NSIS 才接更新器；zip 版没有可覆盖的安装根。 */
export function shouldEnableUpdater(o: {
  isPackaged: boolean;
  platform: string;
  channel: UpdateChannel;
}): boolean {
  return o.isPackaged && o.platform === 'win32' && o.channel === 'nsis';
}

export function loadAutoCheck(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { autoCheck?: unknown }).autoCheck === true;
  } catch {
    return false;
  }
}

export function saveAutoCheck(file: string, value: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ autoCheck: value }), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 不掩盖原始错误 */ }
    throw e;
  }
}

/** 只依赖这几个成员，测试里可以用一个假对象替掉 electron-updater。 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdaterHooks {
  log(msg: string): void;
  balloon(title: string, content: string): void;
  showError(msg: string): void;
  setTimer(cb: () => void, ms: number): unknown;
  readAutoCheck(): boolean;
  writeAutoCheck(v: boolean): void;
  onChange(): void;
}

export type UpdaterState = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface Updater {
  state(): UpdaterState;
  versionReady(): string | null;
  checkManual(): void;
  setAutoCheck(v: boolean): void;
  scheduleAuto(): void;
  restartToInstall(): void;
}

export function createUpdater(autoUpdater: AutoUpdaterLike, hooks: UpdaterHooks): Updater {
  let state: UpdaterState = 'idle';
  let ready: string | null = null;
  let timer: unknown = null;

  const set = (s: UpdaterState): void => { state = s; hooks.onChange(); };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => set('checking'));
  autoUpdater.on('update-available', () => set('downloading'));
  autoUpdater.on('update-not-available', () => set('idle'));
  autoUpdater.on('update-downloaded', (info) => {
    const v = (info as { version?: unknown } | undefined)?.version;
    ready = typeof v === 'string' ? v : null;
    hooks.log(`更新已下载：${ready ?? '版本未知'}`);
    set('ready');
  });
  autoUpdater.on('error', (e) => {
    const msg = (e as Error | undefined)?.message ?? String(e);
    hooks.log(`更新出错：${msg}`);
    hooks.showError(msg);
    set('error');
  });

  const clearTimer = (): void => {
    if (timer === null || timer === undefined) return;
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    timer = null;
  };

  const checkManual = (): void => {
    if (state === 'checking' || state === 'downloading') return;
    set('checking');
    void autoUpdater.checkForUpdates().catch((e: unknown) => {
      const msg = (e as Error | undefined)?.message ?? String(e);
      hooks.log(`检查更新失败：${msg}`);
      hooks.showError(msg);
      set('error');
    });
  };

  const scheduleAuto = (): void => {
    clearTimer();
    if (!hooks.readAutoCheck()) return;
    timer = hooks.setTimer(() => { timer = null; checkManual(); }, 60_000);
  };

  return {
    state: () => state,
    versionReady: () => ready,
    checkManual,
    setAutoCheck(v) {
      hooks.writeAutoCheck(v);
      if (v) scheduleAuto();
      else clearTimer();
      hooks.onChange();
    },
    scheduleAuto,
    restartToInstall() {
      if (state === 'ready') autoUpdater.quitAndInstall();
    },
  };
}
