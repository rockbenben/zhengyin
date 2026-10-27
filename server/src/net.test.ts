import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { isPortListening, pickFreePort } from './net.js';

describe('端口工具', () => {
  it('挑出来的端口能立刻绑上', async () => {
    const port = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const s = createServer().listen(port, '127.0.0.1', () => s.close(() => resolve()));
      s.on('error', reject);
    });
  });

  it('有人在听 → true；没人听 → false', async () => {
    const port = await pickFreePort();
    const s = createServer().listen(port, '127.0.0.1');
    await new Promise<void>((r) => s.once('listening', () => r()));
    expect(await isPortListening(port, '127.0.0.1')).toBe(true);
    await new Promise<void>((r) => s.close(() => r()));
    expect(await isPortListening(port, '127.0.0.1', 200)).toBe(false);
  });
});
