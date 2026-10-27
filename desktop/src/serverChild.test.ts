import { describe, it, expect, vi } from 'vitest';
import { serverEnv, waitUntilHealthy } from './serverChild.js';
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
