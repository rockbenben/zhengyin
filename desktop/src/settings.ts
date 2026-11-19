import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DesktopSettings {
  schemaVersion: 1;
  appRoot: string;
  preferences?: RendererPreferences;
}

const PREFERENCE_KEYS = [
  'overprint.hue', 'overprint.paper', 'pron:noise-suppression', 'pron:ai-show-subscription-plans',
] as const;
type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
export type RendererPreferences = Partial<Record<PreferenceKey, string>>;

export function isPreference(key: unknown, value: unknown): key is PreferenceKey {
  if (typeof value !== 'string') return false;
  switch (key) {
    case 'overprint.hue': return /^\d{1,3}$/.test(value) && Number(value) < 360;
    case 'overprint.paper': return ['"light"', '"dark"', '"system"'].includes(value);
    case 'pron:noise-suppression':
    case 'pron:ai-show-subscription-plans': return value === 'on' || value === 'off';
    default: return false;
  }
}

export function readDesktopSettings(file: string): DesktopSettings | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopSettings>;
    if (raw.schemaVersion !== 1 || typeof raw.appRoot !== 'string' || !raw.appRoot.trim()) return null;
    const result: DesktopSettings = { schemaVersion: 1, appRoot: raw.appRoot };
    const preferences: RendererPreferences = {};
    for (const key of PREFERENCE_KEYS) {
      const value = raw.preferences?.[key];
      if (isPreference(key, value)) preferences[key] = value;
    }
    if (Object.keys(preferences).length) result.preferences = preferences;
    return result;
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
