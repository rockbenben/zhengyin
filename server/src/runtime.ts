import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serverHost, serverPort } from './port.js';

export interface RuntimeEnv { [key: string]: string | undefined }

export interface RuntimePaths {
  shippedRoot: string;
  appRoot: string;
  dataDir: string;
  envFile: string;
  shippedNotes: string;
  legacyNotes: string | null;
  localNotes: string;
  webDist: string;
  workflowsDir: string;
  asrProjectDir: string;
  uvPath: string;
  host: string;
  port: number;
  asrPort: number | null;
  asrAutostart: boolean;
  desktop: boolean;
  version: string;
}

export interface ResolveRuntimeOptions {
  env?: RuntimeEnv;
  cwd?: string;
  exists?: (p: string) => boolean;
}

/** 兼容从仓库根（npm start）或从 server/ 内部（tsx watch）启动两种情况 */
export function defaultAppRoot(cwd: string, exists: (p: string) => boolean = existsSync): string {
  return exists(join(cwd, 'notes')) ? cwd : join(cwd, '..');
}

function portOrNull(raw: string | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`ASR_PORT 必须是 1–65535 的整数，现在是「${s}」`);
  }
  return n;
}

export function resolveRuntime(opts: ResolveRuntimeOptions = {}): RuntimePaths {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;

  const appRoot = resolve(env.APP_ROOT?.trim() || defaultAppRoot(cwd, exists));
  const shippedRoot = resolve(env.SHIPPED_ROOT?.trim() || appRoot);
  const dataDir = resolve(env.DATA_DIR?.trim() || join(appRoot, 'data'));
  const shippedNotes = resolve(env.SHIPPED_NOTES?.trim() || join(shippedRoot, 'notes'));

  const legacyCandidate = resolve(join(appRoot, 'notes'));
  const legacyNotes = env.LEGACY_NOTES?.trim()
    ? resolve(env.LEGACY_NOTES)
    : (legacyCandidate !== shippedNotes && exists(legacyCandidate) ? legacyCandidate : null);

  return {
    shippedRoot,
    appRoot,
    dataDir,
    envFile: resolve(env.ENV_FILE?.trim() || join(appRoot, '.env')),
    shippedNotes,
    legacyNotes,
    localNotes: resolve(env.LOCAL_NOTES?.trim() || join(dataDir, 'notes')),
    webDist: resolve(env.WEB_DIST?.trim() || join(shippedRoot, 'web', 'dist')),
    workflowsDir: resolve(env.WORKFLOWS_DIR?.trim() || join(shippedRoot, 'workflows')),
    asrProjectDir: resolve(env.ASR_PROJECT_DIR?.trim() || join(shippedRoot, 'asr-service')),
    uvPath: env.UV_PATH?.trim() || 'uv',
    host: serverHost(env),
    port: serverPort(env),
    asrPort: portOrNull(env.ASR_PORT),
    asrAutostart: env.ASR_AUTOSTART !== '0',
    desktop: env.APP_RUNTIME === 'desktop',
    version: env.APP_VERSION?.trim() || '',
  };
}
