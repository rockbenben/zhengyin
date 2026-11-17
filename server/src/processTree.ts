import { spawnSync } from 'node:child_process';

// pid 来自本进程刚启动的子进程。POSIX 子进程由调用方放入独立进程组。
export function stopChildTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程组已退出 */ }
}
