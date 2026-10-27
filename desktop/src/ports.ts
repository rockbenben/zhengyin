import { createServer } from 'node:net';

/** 让操作系统分一个当前空闲的端口；挑完到绑定之间有一个很小的窗口，可接受。 */
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
