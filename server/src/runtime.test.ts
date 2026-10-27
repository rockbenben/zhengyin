import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveRuntime } from './runtime.js';

const cwd = resolve('/repo');

describe('resolveRuntime', () => {
  it('浏览器模式：仓库根就是两个根，本机笔记进 data/notes', () => {
    const r = resolveRuntime({ cwd, env: {}, exists: (p) => p === join(cwd, 'notes') });
    expect(r.appRoot).toBe(cwd);
    expect(r.shippedRoot).toBe(cwd);
    expect(r.dataDir).toBe(join(cwd, 'data'));
    expect(r.shippedNotes).toBe(join(cwd, 'notes'));
    expect(r.localNotes).toBe(join(cwd, 'data', 'notes'));
    expect(r.legacyNotes).toBeNull();
    expect(r.host).toBe('127.0.0.1');
    expect(r.port).toBe(30031);
    expect(r.asrPort).toBeNull();
    expect(r.asrAutostart).toBe(true);
    expect(r.desktop).toBe(false);
  });

  it('桌面模式：资源只读、数据在 appRoot，旧 notes 作为中间根', () => {
    const resources = resolve('/app/resources');
    const appRoot = resolve('/app/data-root');
    const r = resolveRuntime({
      cwd: resources,
      env: {
        SHIPPED_ROOT: resources, APP_ROOT: appRoot, APP_RUNTIME: 'desktop',
        APP_VERSION: '1.1.0', HOST: '0.0.0.0', PORT: '30100', ASR_PORT: '30101',
      },
      exists: (p) => p === join(appRoot, 'notes'),
    });
    expect(r.shippedNotes).toBe(join(resources, 'notes'));
    expect(r.legacyNotes).toBe(join(appRoot, 'notes'));
    expect(r.localNotes).toBe(join(appRoot, 'data', 'notes'));
    expect(r.webDist).toBe(join(resources, 'web', 'dist'));
    expect(r.workflowsDir).toBe(join(resources, 'workflows'));
    expect(r.asrProjectDir).toBe(join(resources, 'asr-service'));
    expect(r.host).toBe('0.0.0.0');
    expect(r.port).toBe(30100);
    expect(r.asrPort).toBe(30101);
    expect(r.desktop).toBe(true);
    expect(r.version).toBe('1.1.0');
  });

  it('每一项都能单独覆盖；ASR_AUTOSTART=0 关掉自启', () => {
    const r = resolveRuntime({
      cwd,
      env: {
        SHIPPED_NOTES: '/a', LEGACY_NOTES: '/b', LOCAL_NOTES: '/c',
        WEB_DIST: '/d', WORKFLOWS_DIR: '/e', ASR_PROJECT_DIR: '/f',
        UV_PATH: '/g/uv', ASR_AUTOSTART: '0', ENV_FILE: '/h/.env',
      },
      exists: () => false,
    });
    expect([r.shippedNotes, r.legacyNotes, r.localNotes, r.webDist, r.workflowsDir, r.asrProjectDir])
      .toEqual([resolve('/a'), resolve('/b'), resolve('/c'), resolve('/d'), resolve('/e'), resolve('/f')]);
    expect(r.uvPath).toBe('/g/uv');
    expect(r.envFile).toBe(resolve('/h/.env'));
    expect(r.asrAutostart).toBe(false);
  });

  it('ASR_PORT 写坏了就明确失败，不静默落回默认', () => {
    expect(() => resolveRuntime({ cwd, env: { ASR_PORT: 'abc' } })).toThrow(/ASR_PORT/);
    expect(() => resolveRuntime({ cwd, env: { ASR_PORT: '70000' } })).toThrow(/ASR_PORT/);
  });
});
