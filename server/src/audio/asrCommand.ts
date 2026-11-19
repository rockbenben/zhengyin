import { exec, execFile } from 'node:child_process';
import { join } from 'node:path';

/** uv 低于这个版本就不认 `--project` / `--frozen` 的组合；升级比猜错误便宜 */
export const MIN_UV_VERSION = '0.5.0';

export function parseUvVersion(output: string): [number, number, number] | null {
  const m = /\buv\s+(\d+)\.(\d+)\.(\d+)/i.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function uvVersionProblem(output: string): string | null {
  const v = parseUvVersion(output);
  if (!v) return `看不懂 uv 的版本（它说的是「${output.trim().slice(0, 80)}」）。装一个新的 uv 再试。`;
  const min = MIN_UV_VERSION.split('.').map(Number);
  const older = v[0] !== min[0] ? v[0] < min[0] : v[1] !== min[1] ? v[1] < min[1] : v[2] < min[2];
  return older ? `uv ${v.join('.')} 太旧了，识别服务要 ${MIN_UV_VERSION} 以上。升级 uv 再试。` : null;
}

export type ProbeRun = (command: string, args: readonly string[] | null, signal?: AbortSignal) => string | null | Promise<string | null>;

const VERSION_ARGS = ['--version'] as const;

/**
 * args 为 null 时走 shell（Windows 上 npm 装的 `.cmd` shim 需要）；
 * 有 args 时直接按参数数组跑，打包后的路径可能带空格，数组不会被拆开。
 */
function defaultRun(command: string, args: readonly string[] | null, signal?: AbortSignal): Promise<string | null> {
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000, signal } as const;
  return new Promise((resolve) => {
    const done = (error: Error | null, stdout: string, stderr: string) => {
      resolve(error ? null : `${stdout}${stderr}`.trim() || null);
    };
    if (args === null) exec(command, options, done);
    else execFile(command, args, options, done);
  });
}

export async function probeUv(uvPath: string, { run = defaultRun, signal }: { run?: ProbeRun; signal?: AbortSignal } = {}): Promise<{ found: boolean; output: string }> {
  const direct = await run(uvPath, VERSION_ARGS, signal);
  if (direct) return { found: true, output: direct };

  const shell = signal?.aborted ? null : await run(`"${uvPath}" --version`, null, signal);
  if (shell) return { found: true, output: shell };

  return { found: false, output: '' };
}

export interface AsrCommandInput {
  uvPath: string;
  projectDir: string;
  port: number;
  dataDir: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildAsrCommand(input: AsrCommandInput): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const asrData = join(input.dataDir, 'asr');
  return {
    command: input.uvPath,
    args: [
      'run', '--frozen', '--project', input.projectDir,
      'uvicorn', 'main:app', '--app-dir', input.projectDir,
      '--host', '127.0.0.1', '--port', String(input.port),
    ],
    env: {
      ...input.baseEnv,
      // 安装目录可能只读：venv、缓存、下载的 Python、pyc 都不能落在工程目录里
      UV_PROJECT_ENVIRONMENT: join(asrData, 'venv'),
      UV_CACHE_DIR: join(asrData, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(asrData, 'python'),
      PYTHONPYCACHEPREFIX: join(asrData, 'pycache'),
      PYTHONIOENCODING: 'utf-8',
      DISABLE_SAFETENSORS_CONVERSION: '1',
    },
  };
}
