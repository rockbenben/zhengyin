import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * 同一个数据目录只允许一个正音进程。
 *
 * 首启向导允许把 APP_ROOT 指到仓库文件夹，而那正是 `npm start` 在用的目录；
 * 网页版和桌面版同时写 review-state、发音档案和 SQLite，坏法没有任何提示。
 * 这里宁可明确拒绝，也不赌 WAL 能兜住非数据库文件。
 */
export class DataLockBusyError extends Error {
  constructor(readonly pid: number, readonly host: string, readonly file: string) {
    super(`这个数据文件夹正被另一个正音进程使用（pid ${pid}，${host}）。先关掉它再试。`);
    this.name = 'DataLockBusyError';
  }
}

export interface LockHandle {
  file: string;
  release(): void;
}

export interface LockOptions {
  pid?: number;
  host?: string;
  now?: () => string;
  alive?: (pid: number) => boolean;
  /** 其他主机留下的锁无法探活；超过这个时长就按残锁处理 */
  foreignStaleMs?: number;
}

interface LockFile {
  pid?: unknown;
  host?: unknown;
  startedAt?: unknown;
}

const DEFAULT_FOREIGN_STALE_MS = 12 * 60 * 60 * 1000;

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Windows 上对活着的进程也可能报 EPERM：那仍然是活着
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockFile | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockFile;
  } catch {
    return null;
  }
}

function startedAtMs(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export function acquireDataLock(dataDir: string, opts: LockOptions = {}): LockHandle {
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const now = opts.now ?? (() => new Date().toISOString());
  const alive = opts.alive ?? defaultAlive;
  const foreignStaleMs = opts.foreignStaleMs ?? DEFAULT_FOREIGN_STALE_MS;

  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, '.lock');

  if (existsSync(file)) {
    const parsed = readLock(file);
    const otherPid = typeof parsed?.pid === 'number' ? parsed.pid : null;
    const otherHost = typeof parsed?.host === 'string' ? parsed.host : '';
    const started = startedAtMs(parsed?.startedAt);

    if (otherPid !== null && otherPid !== pid) {
      if (otherHost === host && alive(otherPid)) {
        throw new DataLockBusyError(otherPid, otherHost || host, file);
      }
      if (otherHost !== host) {
        const age = started === null ? Number.POSITIVE_INFINITY : Date.now() - started;
        if (age < foreignStaleMs) {
          throw new DataLockBusyError(otherPid, otherHost || '另一台机器', file);
        }
      }
    }
    // 残锁、坏文件、或者是我们自己的旧锁：接管
    rmSync(file, { force: true });
  }

  const body = JSON.stringify({ pid, host, startedAt: now() });
  try {
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const parsed = readLock(file);
      const otherPid = typeof parsed?.pid === 'number' ? parsed.pid : pid;
      throw new DataLockBusyError(otherPid, typeof parsed?.host === 'string' ? parsed.host : host, file);
    }
    throw e;
  }

  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      // 只删自己的锁：万一我们的锁被当成残锁接管过，别把新主人的锁删了
      const parsed = readLock(file);
      if (parsed && typeof parsed.pid === 'number' && parsed.pid !== pid) return;
      rmSync(file, { force: true });
    },
  };
}
