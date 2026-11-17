import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL, USER_ACTIONS, UPDATER_ACTIONS, DEV_ACTIONS } from './bridge.js';

/**
 * 桌面外壳 ↔ 网页那根线的守卫。
 *
 * **为什么需要它**：这根线的形状在这个仓库里有三份抄本——正本在 `bridge.ts`，
 * preload 抄一份（沙箱里的 require 取不到旁边的文件，抄不了正本只能抄），网页再抄
 * 一份方法名（`web/src/lib/desktop.ts`，那边也有它自己的一份理由）。抄错的后果不是
 * 报错，而是**按钮点了没反应**——那种坏法最难查，所以在这里钉住。
 *
 * 同理，主进程给每个频道都装了 handler，装的和清单对不上也是同样的坏法。
 */
const here = import.meta.dirname;
const preloadSrc = readFileSync(join(here, 'preload.cts'), 'utf8');
const mainSrc = readFileSync(join(here, 'main.ts'), 'utf8');

describe('preload 抄的那份频道名，得跟正本一字不差', () => {
  for (const [name, value] of Object.entries(CHANNEL)) {
    it(`${name} → ${value}`, () => {
      expect(preloadSrc).toContain(`'${value}'`);
    });
  }

  /**
   * 上一条只验「正本里的值在 preload 里出现过」，**抓不住对调**：
   * 两个值都还在文件里，断言照样全绿。可对调恰恰是抄写时最容易出的错——
   * 而它的后果不是报错，是「点打开数据文件夹却弹了换文件夹的框」。
   * 所以这里按**名字→值**整张表比一次。
   */
  it('名字对得上值：整张表是一张表，不是各出现一次', () => {
    const block = preloadSrc.slice(preloadSrc.indexOf('const CHANNEL = {'));
    const copied: Record<string, string> = {};
    for (const m of block.slice(0, block.indexOf('} as const')).matchAll(/(\w+):\s*'([^']+)'/g)) {
      copied[m[1]] = m[2];
    }
    expect(copied).toEqual({ ...CHANNEL });
  });
});

describe('频道名自己不能撞', () => {
  it('两两不同', () => {
    const values = Object.values(CHANNEL);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('主进程给每一个频道都装了 handler', () => {
  // handler 都走 main.ts 的 handle() 包装（它先过 trustedSender），所以这里认包装。
  const handled = (): string[] =>
    [...mainSrc.matchAll(/\bhandle\(CHANNEL\.(\w+)/g)].map((m) => m[1]);

  it('没有绕过 trustedSender 的 handler', () => {
    expect(mainSrc, '有 handler 直接挂在 ipcMain 上，没校验 sender').not.toMatch(/ipcMain\.handle\(CHANNEL\./);
  });

  it('清单里的频道一个不缺', () => {
    const missing = Object.keys(CHANNEL).filter((k) => !handled().includes(k));
    expect(missing, '这些频道没有 handler：网页点了会没反应').toEqual([]);
  });

  it('main 里没有清单之外的频道——多出来的那条网页根本调不到', () => {
    const extra = handled().filter((k) => !(k in CHANNEL));
    expect(extra).toEqual([]);
  });
});

describe('动作清单', () => {
  it('原来菜单栏上的动作一个都没少', () => {
    expect([...USER_ACTIONS].sort()).toEqual([
      'about',
      'changeDataFolder',
      'openDataFolder',
      'quit',
      'reload',
    ]);
  });

  it('更新那几项只在 NSIS 安装版有，开发工具只在开发模式有', () => {
    expect([...UPDATER_ACTIONS].sort()).toEqual(['checkUpdate', 'restartToUpdate', 'setAutoCheck']);
    expect([...DEV_ACTIONS]).toEqual(['devTools']);
  });

  it('三份清单两两不重叠', () => {
    const all = [...USER_ACTIONS, ...UPDATER_ACTIONS, ...DEV_ACTIONS];
    expect(new Set(all).size).toBe(all.length);
  });
});
