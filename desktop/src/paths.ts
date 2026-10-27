import { join } from 'node:path';

export interface HostInfo {
  isPackaged: boolean;
  resourcesPath: string;
  userData: string;
  repoRoot: string;
}

export interface DesktopPathSettings {
  /** 首启向导选定；不选就是 <userData>/app */
  appRoot?: string;
}

export interface DesktopPaths {
  serverEntry: string;
  nodePath: string;
  uvPath: string;
  appRoot: string;
  dataDir: string;
  shippedRoot: string;
  webDist: string;
  workflowsDir: string;
  asrProjectDir: string;
  logDir: string;
  logFile: string;
}

/**
 * 打包后服务与前端在 resources（只读），数据在用户选的 appRoot；
 * 开发模式全部指向仓库，node/uv 用 PATH 上的（方便 tsx/vitest 调试）。
 */
export function resolveDesktopPaths(host: HostInfo, settings: DesktopPathSettings, env: NodeJS.ProcessEnv = process.env): DesktopPaths {
  const base = host.isPackaged ? host.resourcesPath : host.repoRoot;
  const appRoot = settings.appRoot ?? (host.isPackaged ? join(host.userData, 'app') : host.repoRoot);
  const shippedRoot = host.isPackaged ? host.resourcesPath : host.repoRoot;
  const logDir = join(host.userData, 'logs');
  return {
    serverEntry: join(base, 'server', 'dist', 'index.js'),
    nodePath: host.isPackaged ? join(host.resourcesPath, 'runtime', 'node.exe') : (env.NODE_BINARY || 'node'),
    uvPath: host.isPackaged ? join(host.resourcesPath, 'runtime', 'uv.exe') : (env.UV_PATH || 'uv'),
    appRoot,
    dataDir: join(appRoot, 'data'),
    shippedRoot,
    webDist: join(shippedRoot, 'web', 'dist'),
    workflowsDir: join(shippedRoot, 'workflows'),
    asrProjectDir: join(shippedRoot, 'asr-service'),
    logDir,
    logFile: join(logDir, 'server.log'),
  };
}
