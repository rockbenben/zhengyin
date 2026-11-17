import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { requestStops } from './stopControl.js';

it('stops only the registered service, independent of the listener port', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhengyin-stop-'));
  const moduleUrl = new URL('./stopControl.ts', import.meta.url).href;
  const start = (register: boolean) => spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    import { registerStopControl } from ${JSON.stringify(moduleUrl)};
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      if (${register}) {
        const close = registerStopControl(() => server.close(), ${JSON.stringify(directory)});
        process.on('exit', close);
      }
      console.log(server.address().port);
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const service = start(true);
  const unrelated = start(false);
  const serviceExited = once(service, 'exit');
  try {
    const [[port], [unrelatedPort]] = await Promise.all([
      once(service.stdout!, 'data'),
      once(unrelated.stdout!, 'data'),
    ]);
    expect(Number(String(port).trim())).not.toBe(Number(String(unrelatedPort).trim()));
    expect(await requestStops(directory)).toEqual({ requested: 1, pending: 0 });
    expect(await serviceExited).toEqual([0, null]);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.signalCode).toBeNull();
    expect(await requestStops(directory)).toEqual({ requested: 0, pending: 0 });
  } finally {
    service.kill();
    unrelated.kill();
  }
});
