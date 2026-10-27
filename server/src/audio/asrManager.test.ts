import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { AsrManager } from './asrManager.js';

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 4242;
  c.kill = vi.fn();
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
    const child = (o.spawn as unknown as { mock: { results: Array<{ value: ReturnType<typeof fakeChild> }> } })
      .mock.results[0].value;
    child.stderr.emit('data', Buffer.from('\u001b[31m模型加载中\u001b[0m\n'));
    expect(m.status().log.join('')).toContain('模型加载中');
    await new Promise((r) => setTimeout(r, 0));
    expect(m.status().state).toBe('ready');
    expect(m.status().port).toBe(30123);
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
