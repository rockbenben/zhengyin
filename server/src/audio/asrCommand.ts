import { spawnSync } from 'node:child_process';
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

export type ProbeRun = (command: string, args: readonly string[] | null) => string | null;

// 单独提出来，别在 spawn 附近写数组字面量：spawnShell.test 会按 600 字符窗口扫
// 「命令 + [参数] + shell:true」，同窗口里的无关调用会被它误伤。
const VERSION_ARGS = ['--version'] as const;

const text = (v: string | Buffer | null | undefined): string =>
  typeof v === 'string' ? v : v ? v.toString() : '';

/**
 * args 为 null 时走 shell（Windows 上 npm 装的 `.cmd` shim 需要）；
 * 有 args 时直接按参数数组跑，打包后的路径可能带空格，数组不会被拆开。
 * 两种写法分开，避免在同一处出现「参数数组 + shell:true」。
 */
function defaultRun(command: string, args: readonly string[] | null): string | null {
  const r = args === null
    ? spawnSync(command, { encoding: 'utf8', shell: true, windowsHide: true })
    : spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  const out = `${text(r.stdout)}${text(r.stderr)}`.trim();
  return r.status === 0 && out ? out : null;
}

export function probeUv(uvPath: string, run: ProbeRun = defaultRun): { found: boolean; output: string } {
  const direct = run(uvPath, VERSION_ARGS);
  if (direct) return { found: true, output: direct };

  const shell = run(`"${uvPath}" --version`, null);
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
