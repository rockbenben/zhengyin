import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveDesktopPaths } from './paths.js';

const repo = resolve('/repo');
const userData = resolve('/appdata/zhengyin');

describe('桌面路径', () => {
  it('开发模式：用 PATH 上的 node/uv，资源与数据都在仓库', () => {
    const p = resolveDesktopPaths({ isPackaged: false, resourcesPath: '/nope', userData, repoRoot: repo }, {});
    expect(p.serverEntry).toBe(join(repo, 'server', 'dist', 'index.js'));
    expect(p.nodePath).toBe('node');
    expect(p.uvPath).toBe('uv');
    expect(p.appRoot).toBe(repo);
    expect(p.shippedRoot).toBe(repo);
    expect(p.logDir).toBe(join(userData, 'logs'));
  });

  it('打包模式：运行时与资源在 resources，数据在指定 appRoot', () => {
    const resources = resolve('/app/resources');
    const appRoot = resolve('/data/old-zhengyin');
    const p = resolveDesktopPaths(
      { isPackaged: true, resourcesPath: resources, userData, repoRoot: repo },
      { appRoot },
    );
    expect(p.serverEntry).toBe(join(resources, 'server', 'dist', 'index.js'));
    expect(p.nodePath).toBe(join(resources, 'runtime', 'node.exe'));
    expect(p.uvPath).toBe(join(resources, 'runtime', 'uv.exe'));
    expect(p.appRoot).toBe(appRoot);
    expect(p.shippedRoot).toBe(resources);
    expect(p.webDist).toBe(join(resources, 'web', 'dist'));
    expect(p.asrProjectDir).toBe(join(resources, 'asr-service'));
    expect(p.logFile).toBe(join(userData, 'logs', 'server.log'));
  });
});
