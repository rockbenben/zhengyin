import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { pickFreePort } from './ports.js';

describe('pickFreePort', () => {
  it('挑出来的端口能立刻绑上', async () => {
    const port = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const s = createServer().listen(port, '127.0.0.1', () => s.close(() => resolve()));
      s.on('error', reject);
    });
    expect(port).toBeGreaterThan(0);
  });
});
