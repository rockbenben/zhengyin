import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * tmp + rename 的原子写，带一次 Windows 专用的短暂重试。
 *
 * Windows 上 `renameSync(tmp, file)` 会在目的地被另一个句柄短暂占住时抛 EPERM/EBUSY
 * ——最常见的是杀软/索引器刚扫到新写的 tmp 文件。这不是数据错误，等几十毫秒再试
 * 就好；不重试的表现是保存复习进度/发音档案时随机报一句 EPERM，而文件其实没坏。
 * 重试只针对这三个可恢复的 errno，其余错误立刻抛。
 */
export interface AtomicWriteOptions {
  rename?: typeof renameSync;
  sleep?: (ms: number) => void;
  attempts?: number;
  delayMs?: number;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function writeFileAtomic(file: string, text: string, opts: AtomicWriteOptions = {}): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const rename = opts.rename ?? renameSync;
  const sleep = opts.sleep ?? sleepSync;
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 20;

  try {
    writeFileSync(tmp, text, 'utf8');
    for (let i = 0; ; i++) {
      try {
        rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!retryable || i >= attempts - 1) throw e;
        sleep(delayMs);
      }
    }
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw e;
  }
}
