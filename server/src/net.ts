import { createServer, connect } from 'node:net';

/** 让操作系统分一个当前空闲的端口。挑完到真正绑定之间有一个很小的时间窗，可接受。 */
export function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close(() => reject(new Error('没能挑到空闲端口')));
      }
    });
  });
}

/** 端口上有没有东西在听。注意：这不代表它是我们的边车，调用方还要看 /health 的形状。 */
export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}
