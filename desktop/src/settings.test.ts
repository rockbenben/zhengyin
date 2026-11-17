import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isPreference, readDesktopSettings, writeDesktopSettings } from './settings.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'dset-')), 'desktop-settings.json');

describe('桌面设置', () => {
  it('旧设置可增量保存桌面偏好，保留数据目录并忽略非法字段', () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ schemaVersion: 1, appRoot: 'C:/data' }), 'utf8');
    const old = readDesktopSettings(f)!;
    const preferences = { 'overprint.hue': '300', 'overprint.paper': '"dark"', 'pron:noise-suppression': 'off' };
    writeDesktopSettings(f, { ...old, preferences });
    expect(readDesktopSettings(f)).toEqual({ ...old, preferences });
    expect(isPreference('appRoot', 'C:/new')).toBe(false);
    expect(isPreference('pron:noise-suppression', 'invalid')).toBe(false);
  });
  it('写入后读回', () => {
    const f = file();
    writeDesktopSettings(f, { schemaVersion: 1, appRoot: 'C:/data' });
    expect(readDesktopSettings(f)).toEqual({ schemaVersion: 1, appRoot: 'C:/data' });
  });

  it('文件不存在 / 坏 JSON / 缺字段都回 null', () => {
    const f = file();
    expect(readDesktopSettings(f)).toBeNull();
    writeFileSync(f, '{not json', 'utf8');
    expect(readDesktopSettings(f)).toBeNull();
    writeFileSync(f, JSON.stringify({ schemaVersion: 2, appRoot: 'x' }), 'utf8');
    expect(readDesktopSettings(f)).toBeNull();
    writeFileSync(f, JSON.stringify({ schemaVersion: 1, appRoot: '   ' }), 'utf8');
    expect(readDesktopSettings(f)).toBeNull();
  });
});
