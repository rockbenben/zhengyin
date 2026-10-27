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
} = {}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = opts.nowFn ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 300;
  const deadline = nowFn() + timeoutMs;
  for (;;) {
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
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (b: Buffer) => o.log.write(b.toString()));
  child.stderr?.on('data', (b: Buffer) => o.log.write(b.toString()));

  let killedByUs = false;
  let exited: number | null | undefined;
  let launchError: LaunchError | null = null;
  let cb: ((code: number | null, killedByUs: boolean, launchError: LaunchError | null) => void) | undefined;

  const settle = (code: number | null, err?: NodeJS.ErrnoException) => {
    if (exited !== undefined) return;
    exited = code;
    launchError = err ? { code: err.code, syscall: err.syscall, message: err.message } : null;
    cb?.(code, killedByUs, launchError);
  };
  child.on('exit', (code) => settle(code));
  child.on('error', (err: NodeJS.ErrnoException) => settle(null, err));

  return {
    async stop() {
      if (killedByUs) return;
      killedByUs = true;
      const pid = child.pid;
      child.kill();
      // 给它一点时间走优雅退出（服务自己的处理器会停边车），然后按树强杀。
      await new Promise<void>((r) => setTimeout(r, 1500));
      if (!pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
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
