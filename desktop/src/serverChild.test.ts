import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { LogSink } from './logs.js';
import { serverEnv, waitUntilHealthy, startServer } from './serverChild.js';
import type { DesktopPaths } from './paths.js';

const paths: DesktopPaths = {
  serverEntry: 'C:/res/server/dist/index.js',
  nodePath: 'C:/res/runtime/node.exe',
  uvPath: 'C:/res/runtime/uv.exe',
  appRoot: 'C:/data',
  dataDir: 'C:/data/data',
  shippedRoot: 'C:/res',
  webDist: 'C:/res/web/dist',
  workflowsDir: 'C:/res/workflows',
  asrProjectDir: 'C:/res/asr-service',
  logDir: 'C:/logs',
  logFile: 'C:/logs/server.log',
};

describe('启动接线', () => {
  it('开发壳与服务共用应用包版本', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain('appVersion = pkg().version');
    expect(main).toContain('startServer({ paths, port, log, version: appVersion })');
  });
  it('stderr 排空后保留锁持有 pid，已退出子进程不再杀树', async () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const handle = await startServer({ paths, port: 1, log: { write: vi.fn() } as unknown as LogSink,
      spawnFn: (() => proc as unknown as ChildProcess) as typeof spawn });
    const cb = vi.fn();
    handle.onExit(cb);
    proc.emit('exit', 1);
    expect(cb).not.toHaveBeenCalled();
    const message = '这个数据文件夹正被另一个正音进程使用（pid 123，host）。先关掉它再试。';
    const bytes = Buffer.from(message);
    proc.stderr.write(bytes.subarray(0, 5));
    proc.stderr.write(bytes.subarray(5));
    proc.emit('close', 1);
    expect(cb).toHaveBeenCalledWith(1, false, { code: 'DATA_LOCK_BUSY', message });
    await handle.stop();
    expect(proc.kill).not.toHaveBeenCalled();
  });
  it('真实 Node 子进程的锁拒绝能传回 pid 与完整提示', async () => {
    const message = '这个数据文件夹正被另一个正音进程使用（pid 456，host.name）。先关掉它再试。';
    const handle = await startServer({ paths, port: 1, log: { write: vi.fn() } as unknown as LogSink,
      spawnFn: ((_file: string, _args: readonly string[], opts: SpawnOptions) => spawn(process.execPath,
        ['-e', 'console.error(' + JSON.stringify(message) + '); process.exit(1)'], opts)) as unknown as typeof spawn });
    const result = await new Promise<unknown[]>((resolve) => handle.onExit((...args) => resolve(args)));
    expect(result).toEqual([1, false, { code: 'DATA_LOCK_BUSY', message }]);
    await handle.stop();
  });
  it('通过 IPC 让真实 Node 子进程自行清理并正常退出', async () => {
    const write = vi.fn();
    const spawnFn = ((_file: string, _args: readonly string[], opts: SpawnOptions) => spawn(process.execPath,
      ['-e', `process.on('message', (msg) => {
        if (msg === 'shutdown') process.stdout.write('cleaned', () => process.exit(0));
      });`], opts)) as unknown as typeof spawn;
    const handle = await startServer({ paths, port: 1, log: { write } as unknown as LogSink, spawnFn });
    const onExit = vi.fn();
    handle.onExit(onExit);
    await handle.stop();
    expect(write).toHaveBeenCalledWith('cleaned');
    expect(onExit).toHaveBeenCalledExactlyOnceWith(0, true, null);
  });
  it('锁失败不再等健康超时', async () => {
    const fetchFn = vi.fn();
    expect(await waitUntilHealthy(1, { shouldStop: () => true, fetchFn })).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('serverEnv', () => {
  it('把两个根、运行时与桌面标志都传下去，并清掉 ELECTRON_RUN_AS_NODE', () => {
    const env = serverEnv(paths, 30100, '1.0.0');
    expect(env.PORT).toBe('30100');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.APP_ROOT).toBe('C:/data');
    expect(env.SHIPPED_ROOT).toBe('C:/res');
    expect(env.DATA_DIR).toBe('C:/data/data');
    expect(env.WEB_DIST).toBe('C:/res/web/dist');
    expect(env.UV_PATH).toBe('C:/res/runtime/uv.exe');
    expect(env.ASR_AUTOSTART).toBe('1');
    expect(env.NO_OPEN).toBe('1');
    expect(env.APP_RUNTIME).toBe('desktop');
    expect(env.APP_VERSION).toBe('1.0.0');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

describe('waitUntilHealthy', () => {
  const res = (ok: boolean) => ({ ok, json: async () => ({ ok }) }) as unknown as Response;

  it('先探一次；通了就立刻返回', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => res(++calls > 1)) as unknown as typeof fetch;
    expect(await waitUntilHealthy(1, {
      fetchFn, sleepFn: async () => {}, nowFn: () => 0, timeoutMs: 10,
    })).toBe(true);
  });

  it('超时返回 false', async () => {
    const fetchFn = vi.fn(async () => res(false)) as unknown as typeof fetch;
    expect(await waitUntilHealthy(1, {
      fetchFn, sleepFn: async () => {}, nowFn: () => Date.now(), timeoutMs: 0,
    })).toBe(false);
  });
});
