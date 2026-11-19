import { spawn as spawnNode, spawnSync, type ChildProcess } from 'node:child_process';
import type { DesktopPaths } from './paths.js';
import type { LogSink } from './logs.js';

export interface LaunchError {
  code?: string;
  syscall?: string;
  message: string;
}

export interface ChildHandle {
  stop(): Promise<void>;
  onExit(cb: (code: number | null, killedByUs: boolean, launchError: LaunchError | null) => void): void;
}

/** 服务子进程的环境。桌面标志、两个根、随包 uv 与动态端口都在这里对齐。 */
export function serverEnv(paths: DesktopPaths, port: number, version = ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    APP_ROOT: paths.appRoot,
    SHIPPED_ROOT: paths.shippedRoot,
    DATA_DIR: paths.dataDir,
    WEB_DIST: paths.webDist,
    WORKFLOWS_DIR: paths.workflowsDir,
    ASR_PROJECT_DIR: paths.asrProjectDir,
    UV_PATH: paths.uvPath,
    ASR_AUTOSTART: '1',
    NO_OPEN: '1',
    APP_RUNTIME: 'desktop',
    APP_VERSION: version,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** 「起不来」和「起来了又退了」分开说；前者只有 errno 说得清。 */
export function describeLaunchFailure(e: LaunchError): string {
  if (e.code === 'ENOENT') return '找不到服务入口文件（安装目录可能不完整）';
  if (e.code === 'EACCES' || e.code === 'EPERM') return '系统拒绝创建这个进程（多半被安全软件拦了）';
  return e.message;
}

export async function waitUntilHealthy(port: number, opts: {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
  shouldStop?: () => boolean;
} = {}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = opts.nowFn ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 300;
  const deadline = nowFn() + timeoutMs;
  for (;;) {
    if (opts.shouldStop?.()) return false;
    try {
      const r = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.json() as { ok?: unknown }).ok === true) return true;
    } catch { /* 继续等 */ }
    if (nowFn() >= deadline) return false;
    await sleepFn(intervalMs);
  }
}

export async function startServer(o: {
  paths: DesktopPaths;
  port: number;
  log: LogSink;
  version?: string;
  spawnFn?: typeof spawnNode;
  fetchFn?: typeof fetch;
}): Promise<ChildHandle> {
  const child = (o.spawnFn ?? spawnNode)(o.paths.nodePath, [o.paths.serverEntry], {
    env: serverEnv(o.paths, o.port, o.version),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.stdout?.on('data', (b: Buffer) => o.log.write(b.toString()));
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text: string) => {
    stderr = (stderr + text).slice(-8192);
    o.log.write(text);
  });

  let killedByUs = false;
  let exited: number | null | undefined;
  let launchError: LaunchError | null = null;
  let cb: ((code: number | null, killedByUs: boolean, launchError: LaunchError | null) => void) | undefined;
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolve) => { notifyClosed = resolve; });

  const settle = (code: number | null, err?: NodeJS.ErrnoException) => {
    if (exited !== undefined) return;
    exited = code;
    const busy = stderr.match(/^这个数据文件夹正被另一个正音进程使用（pid [0-9]+，.+$/mu)?.[0].trim();
    launchError = err ? { code: err.code, syscall: err.syscall, message: err.message }
      : busy ? { code: 'DATA_LOCK_BUSY', message: busy } : null;
    notifyClosed();
    cb?.(code, killedByUs, launchError);
  };
  // close 在 stderr 排空后触发，避免漏掉服务退出前写出的锁持有者。
  child.on('close', (code) => settle(code));
  child.on('error', (err: NodeJS.ErrnoException) => settle(null, err));

  return {
    async stop() {
      if (killedByUs || exited !== undefined) return;
      killedByUs = true;
      const pid = child.pid;
      // Windows 的 child.kill() 会先杀掉树根。让服务自己收边车，超时时再从活着的树根整体终止。
      if (child.connected) {
        const sent = new Promise<void>((resolve) => {
          child.send('shutdown', (error) => { if (error) resolve(); });
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000); });
        await Promise.race([closed, sent, deadline]);
        clearTimeout(timer);
      }
      if (!pid || exited !== undefined || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        if (result.status !== 0 && child.exitCode === null) o.log.write('[desktop] 无法终止后台服务进程树\n');
      } else {
        try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      }
    },
    onExit(f) {
      cb = f;
      if (exited !== undefined) f(exited, killedByUs, launchError);
    },
  };
}
