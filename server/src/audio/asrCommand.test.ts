import { describe, it, expect } from 'vitest';
import { buildAsrCommand, parseUvVersion, probeUv, uvVersionProblem } from './asrCommand.js';

describe('ASR 命令', () => {
  it('冻结 lock、指定工程与 app-dir，venv/缓存/Python/pycache 全部重定向', () => {
    const c = buildAsrCommand({
      uvPath: 'C:/uv.exe', projectDir: 'C:/res/asr-service', port: 30123,
      dataDir: 'C:/root/data', baseEnv: { MODEL_SOURCE: 'modelscope' },
    });
    expect(c.command).toBe('C:/uv.exe');
    expect(c.args).toEqual([
      'run', '--frozen', '--project', 'C:/res/asr-service',
      'uvicorn', 'main:app', '--app-dir', 'C:/res/asr-service',
      '--host', '127.0.0.1', '--port', '30123',
    ]);
    expect(c.env.UV_PROJECT_ENVIRONMENT).toMatch(/data[\\/]asr[\\/]venv$/);
    expect(c.env.UV_CACHE_DIR).toMatch(/data[\\/]asr[\\/]uv-cache$/);
    expect(c.env.UV_PYTHON_INSTALL_DIR).toMatch(/data[\\/]asr[\\/]python$/);
    expect(c.env.PYTHONPYCACHEPREFIX).toMatch(/data[\\/]asr[\\/]pycache$/);
    expect(c.env.PYTHONIOENCODING).toBe('utf-8');
    expect(c.env.DISABLE_SAFETENSORS_CONVERSION).toBe('1');
    expect(c.env.MODEL_SOURCE).toBe('modelscope');
  });

  it('uv 版本解析与下限', () => {
    expect(parseUvVersion('uv 0.11.3 (45da18ac3 2026-04-01 x86_64-pc-windows-msvc)')).toEqual([0, 11, 3]);
    expect(uvVersionProblem('uv 0.11.3 (…)')).toBeNull();
    expect(uvVersionProblem('uv 0.4.9 (…)')).toMatch(/升级 uv/);
    expect(uvVersionProblem('不是版本')).toMatch(/uv/);
  });
});

describe('probeUv', () => {
  it('直接跑路径成功就用它', () => {
    const calls: Array<[string, readonly string[] | null]> = [];
    const run = (command: string, args: readonly string[] | null) => {
      calls.push([command, args]);
      return 'uv 0.11.3 (x)';
    };
    const r = probeUv('C:/Program Files/uv.exe', run);
    expect(r).toEqual({ found: true, output: 'uv 0.11.3 (x)' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('C:/Program Files/uv.exe');
    expect(calls[0][1]).toEqual(['--version']);
  });

  it('直接跑失败时退回 shell 形式（照顾 .cmd shim）', () => {
    const calls: Array<[string, readonly string[] | null]> = [];
    const run = (command: string, args: readonly string[] | null) => {
      calls.push([command, args]);
      return calls.length === 1 ? null : 'uv 0.11.3 (x)';
    };
    const r = probeUv('uv', run);
    expect(r.found).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe('"uv" --version');
    expect(calls[1][1]).toBeNull();
  });

  it('两条路都失败 → found:false', () => {
    expect(probeUv('uv', () => null)).toEqual({ found: false, output: '' });
  });
});
