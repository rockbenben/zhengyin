import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const stopDirectory = join(import.meta.dirname, '..', '..', 'data', 'stop-control');

// 每次启动使用独立标记。停止脚本只投递退出请求，由持有该标记的进程自行清理。
export function registerStopControl(stop: () => void, directory = stopDirectory): () => void {
  mkdirSync(directory, { recursive: true });
  const record = join(directory, `${process.pid}-${randomUUID()}.run`);
  const request = `${record}.stop`;
  writeFileSync(record, '', { flag: 'wx' });
  const timer = setInterval(() => {
    if (!existsSync(request)) return;
    clearInterval(timer);
    stop();
  }, 250);
  timer.unref();
  return () => {
    clearInterval(timer);
    rmSync(request, { force: true });
    rmSync(record, { force: true });
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function requestStops(directory = stopDirectory, timeoutMs = 8000): Promise<{ requested: number; pending: number }> {
  let records: string[];
  try {
    records = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { requested: 0, pending: 0 };
    throw error;
  }
  const targets: string[] = [];
  for (const name of records) {
    const match = /^(\d{1,10})-[0-9a-f-]{36}\.run$/.exec(name);
    if (!match) continue;
    const record = join(directory, name);
    const pid = Number(match[1]);
    if (pid < 1 || pid > 0x7fffffff || !isAlive(pid)) {
      rmSync(`${record}.stop`, { force: true });
      rmSync(record, { force: true });
      continue;
    }
    targets.push(record);
    try {
      writeFileSync(`${record}.stop`, '', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const deadline = Date.now() + timeoutMs;
  let pending = targets.filter(existsSync);
  while (pending.length > 0 && Date.now() < deadline) {
    await delay(100);
    pending = pending.filter(existsSync);
  }
  for (const record of targets) {
    if (!existsSync(record)) rmSync(`${record}.stop`, { force: true });
  }
  return { requested: targets.length, pending: pending.length };
}
