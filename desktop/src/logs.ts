import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LINES = 300;

/**
 * 服务子进程的日志落盘 + 内存尾部。
 *
 * 桌面版没有控制台：不落文件就等于「起不来时什么都看不到」。写入失败不能反过来
 * 把应用弄崩——日志是诊断手段，不是主路径。
 */
export class LogSink {
  private lines: string[] = [];
  private pending = '';

  constructor(private file: string, private maxBytes = 2 * 1024 * 1024) {
    mkdirSync(dirname(file), { recursive: true });
  }

  get path(): string { return this.file; }

  write(chunk: string): void {
    const text = this.pending + chunk;
    const parts = text.split(/\r?\n/);
    this.pending = parts.pop() ?? '';
    for (const line of parts) {
      this.lines.push(line);
      if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    }
    try {
      if (this.size() + Buffer.byteLength(text) > this.maxBytes) {
        const old = `${this.file}.1`;
        rmSync(old, { force: true });
        if (existsSync(this.file)) renameSync(this.file, old);
      }
      appendFileSync(this.file, text, 'utf8');
    } catch (e) {
      // 盘满/目录被删都不能让服务启动失败；控制台里留一句就够
      console.warn(`[desktop] 写日志失败：${(e as Error).message}`);
    }
  }

  tail(n = 40): string[] {
    const all = this.pending ? [...this.lines, this.pending] : this.lines;
    return all.slice(-n);
  }

  private size(): number {
    try { return statSync(this.file).size; } catch { return 0; }
  }
}
