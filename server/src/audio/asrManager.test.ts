import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { AsrManager } from './asrManager.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null;
  };
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.pid = 4242;
  c.exitCode = null;
  c.signalCode = null;
  return c;
}

const base = () => ({
  projectDir: '/res/asr-service',
  uvPath: 'uv',
  dataDir: '/data',
  explicitPort: null as number | null,
  autostart: true,
  probeUv: () => ({ found: true, output: 'uv 0.11.3 (x)' }),
  pickPort: async () => 30123,
  isListening: async () => false,
  fetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as unknown as typeof fetch,
  spawn: vi.fn(() => fakeChild() as unknown as ChildProcess) as unknown as typeof import('node:child_process').spawn,
  killTree: vi.fn(),
  sleep: async () => {},
});

describe('AsrManager', () => {
  it('shares a single restart while the port is being selected', async () => {
    const port = deferred<number>();
    const o = { ...base(), pickPort: vi.fn(() => port.promise) };
    const m = new AsrManager(o);
    const first = m.restart();
    const second = m.restart();
    await vi.waitFor(() => expect(o.pickPort).toHaveBeenCalledOnce());
    port.resolve(30123);
    await Promise.all([first, second]);
    expect(o.spawn).toHaveBeenCalledOnce();
    m.stop();
    expect(o.killTree).toHaveBeenCalledExactlyOnceWith(4242);
  });

  it('探测 uv 时立即报告启动中，退出时取消探测且不会再启动进程', async () => {
    const probe = deferred<{ found: boolean; output: string }>();
    const o = { ...base(), probeUv: vi.fn((_signal: AbortSignal) => probe.promise) };
    const m = new AsrManager(o);
    const pending = m.start();
    expect(m.status()).toMatchObject({ state: 'starting', stage: null });
    expect(o.spawn).not.toHaveBeenCalled();
    m.stop();
    expect(o.probeUv.mock.calls[0][0].aborted).toBe(true);
    probe.resolve({ found: true, output: 'uv 0.11.3' });
    await pending;
    expect(o.spawn).not.toHaveBeenCalled();
    expect(m.status().state).toBe('off');
  });

  it('discards port and health results from a stopped generation', async () => {
    const port = deferred<number>();
    const health = deferred<Response>();
    const o = { ...base(), pickPort: vi.fn(() => port.promise), fetch: vi.fn(() => health.promise) };
    const m = new AsrManager(o);
    const starting = m.start();
    await vi.waitFor(() => expect(o.pickPort).toHaveBeenCalledOnce());
    m.stop();
    port.resolve(30123);
    await starting;
    expect(o.spawn).not.toHaveBeenCalled();
    await m.restart();
    expect(o.spawn).toHaveBeenCalledOnce();
    m.stop();
    health.resolve(Response.json({ ok: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.status().state).toBe('off');
  });
  it('autostart 关掉 → off，不 spawn', async () => {
    const o = { ...base(), autostart: false };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('off');
    expect(o.spawn).not.toHaveBeenCalled();
  });

  it('没有 uv → no-uv，不 spawn', async () => {
    const o = { ...base(), probeUv: () => ({ found: false, output: '' }) };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('no-uv');
    expect(o.spawn).not.toHaveBeenCalled();
  });

  it('uv 太旧 → error，说升级', async () => {
    const o = { ...base(), probeUv: () => ({ found: true, output: 'uv 0.4.9 (x)' }) };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toMatch(/升级 uv/);
  });

  it('起进程、日志进环形缓冲、健康后 ready', async () => {
    const o = base();
    const m = new AsrManager(o);
    await m.start();
    expect(o.spawn).toHaveBeenCalledOnce();
    expect(o.spawn).toHaveBeenCalledWith('uv', expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({ ZHENGYIN_ASR_PARENT_PIPE: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const child = (o.spawn as unknown as { mock: { results: Array<{ value: ReturnType<typeof fakeChild> }> } })
      .mock.results[0].value;
    child.stderr.write('\u001b[31m模型加载中\u001b[0m\n');
    expect(m.status().log.join('')).toContain('模型加载中');
    await new Promise((r) => setTimeout(r, 0));
    expect(m.status().state).toBe('ready');
    expect(m.status().port).toBe(30123);
  });

  it('从依赖安装切到模型加载，进度消除停滞提示，无进展超时关闭本次进程', async () => {
    let now = 0;
    let tick = deferred<void>();
    const o = {
      ...base(), now: () => now,
      fetch: vi.fn(async () => Response.json({ ok: false })) as unknown as typeof fetch,
      sleep: vi.fn(() => tick.promise),
    };
    const m = new AsrManager(o);
    await m.start();
    const child = vi.mocked(o.spawn).mock.results[0].value as unknown as ReturnType<typeof fakeChild>;
    expect(m.status()).toMatchObject({ state: 'starting', stage: 'dependencies', stalled: false });
    await vi.waitFor(() => expect(o.sleep).toHaveBeenLastCalledWith(1000));
    now = 120_000;
    child.stdout.write('[zhengyin-asr] parent-ping\n');
    expect(m.status().stalled).toBe(true);
    child.stdout.write('[zhengyin-asr] mo');
    child.stdout.write('del\n');
    expect(m.status()).toMatchObject({ state: 'starting', stage: 'model', stalled: false });
    const checkModel = tick.resolve;
    tick = deferred<void>();
    checkModel();
    await vi.waitFor(() => expect(o.sleep).toHaveBeenLastCalledWith(250));
    now += 120_000;
    child.stderr.write('正在下载模型 25%\r正在下载模型 26%\r\n');
    expect(m.status()).toMatchObject({ stalled: false, log: ['正在下载模型 25%', '正在下载模型 26%'] });
    now += 600_000;
    const resume = tick.resolve;
    tick = deferred<void>();
    resume();
    await vi.waitFor(() => expect(m.status()).toMatchObject({ state: 'error', error: expect.stringContaining('加载识别模型超时') }));
    expect(o.killTree).toHaveBeenCalledExactlyOnceWith(4242);
  });

  it('依赖安装失败保留退出码与 stderr', async () => {
    const o = { ...base(), fetch: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch };
    const m = new AsrManager(o);
    await m.start();
    const child = vi.mocked(o.spawn).mock.results[0].value as unknown as ReturnType<typeof fakeChild>;
    child.stderr.write('error: Failed to download torch\n');
    child.emit('close', 1, null);
    expect(m.status()).toMatchObject({ state: 'error', error: expect.stringContaining('安装识别依赖失败（退出码 1）') });
    expect(m.status().log).toContain('error: Failed to download torch');
  });

  it('显式端口有人在听 → 接管，不 spawn', async () => {
    const o = { ...base(), explicitPort: 30032, isListening: async () => true };
    const m = new AsrManager(o);
    await m.start();
    expect(o.spawn).not.toHaveBeenCalled();
    expect(m.status().port).toBe(30032);
  });

  it('显式端口被别的程序占着（不是我们的 /health）→ error', async () => {
    const o = {
      ...base(),
      explicitPort: 30032,
      isListening: async () => true,
      fetch: vi.fn(async () => { throw new Error('not ours'); }) as unknown as typeof fetch,
    };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toMatch(/占/);
  });

  it('stop 按进程树杀、幂等、状态回 off', async () => {
    const o = base();
    const m = new AsrManager(o);
    await m.start();
    m.stop();
    m.stop();
    expect(o.killTree).toHaveBeenCalledTimes(1);
    expect(m.status().state).toBe('off');
  });
});
