import { describe, it, expect, vi } from 'vitest';
import { buildMenuTemplate } from './menu.js';

it('菜单里有打开/更换数据文件夹、检查更新、退出', () => {
  const labels: string[] = [];
  const t = buildMenuTemplate({
    openDataFolder: vi.fn(),
    changeDataFolder: vi.fn(),
    reload: vi.fn(),
    quit: vi.fn(),
    about: vi.fn(),
    updater: { check: vi.fn(), restart: vi.fn(), autoCheck: true, toggleAutoCheck: vi.fn(), readyVersion: null },
  });
  const walk = (items: Array<{ label?: string; submenu?: unknown }>) => {
    for (const i of items) {
      if (i.label) labels.push(i.label);
      if (Array.isArray(i.submenu)) walk(i.submenu as Array<{ label?: string; submenu?: unknown }>);
    }
  };
  walk(t as unknown as Array<{ label?: string; submenu?: unknown }>);
  expect(labels).toEqual(expect.arrayContaining(['打开数据文件夹', '更换数据文件夹…', '检查更新', '退出']));
});
