import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DesktopSettings {
  schemaVersion: 1;
  appRoot: string;
}

export function readDesktopSettings(file: string): DesktopSettings | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopSettings>;
    if (raw.schemaVersion !== 1 || typeof raw.appRoot !== 'string' || !raw.appRoot.trim()) return null;
    return { schemaVersion: 1, appRoot: raw.appRoot };
  } catch {
    return null;
  }
}

export function writeDesktopSettings(file: string, s: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw e;
  }
}
