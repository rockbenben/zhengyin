import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopBridge } from './desktop';

/**
 * 网页 ↔ 桌面外壳那根线的守卫。
 *
 * **为什么有三份**：正本在 `desktop/src/bridge.ts`（主进程那一侧）；
 * preload 抄一份（沙箱里的 `require` 取不到旁边的文件，抄不了正本只能抄）；
 * 网页再抄一份（两个包各编各的，为十来行接口另起共享包不值当）。
 *
 * 抄错的后果不是报错，是**按钮点了没反应**——那种坏法最难查，所以在这里钉住。
 */
const root = join(import.meta.dirname, '..', '..', '..');
const desktopSrc = readFileSync(join(root, 'desktop', 'src', 'bridge.ts'), 'utf8');
const preloadSrc = readFileSync(join(root, 'desktop', 'src', 'preload.cts'), 'utf8');
const webSrc = readFileSync(join(root, 'web', 'src', 'lib', 'desktop.ts'), 'utf8');

/** 正本里的频道名（bridge.ts 的 CHANNEL） */
const channels = (): string[] =>
  [...desktopSrc.matchAll(/^\s{2}(\w+):\s*'desktop:/gm)].map((m) => m[1]);

/** preload 递出去的方法 */
const preloadMethods = (): string[] =>
  [...preloadSrc.matchAll(/\n {2}(\w+):\s*\(/g)].map((m) => m[1]);

/** 网页这边声明的方法 */
const webMethods = (): string[] => {
  const block = webSrc.slice(webSrc.indexOf('export interface DesktopBridge'));
  return [...block.matchAll(/\n {2}(\w+)\(/g)].map((m) => m[1]);
};

describe('三份动作清单是同一批', () => {
  it('网页跟 preload 一致', () => {
    expect(webMethods().sort()).toEqual(preloadMethods().sort());
  });

  it('preload 跟桌面正本一致', () => {
    expect(preloadMethods().sort()).toEqual(channels().sort());
  });

  it('一个都不能少：原来菜单栏上的动作都在', () => {
    for (const a of ['state', 'openDataFolder', 'changeDataFolder', 'reload', 'quit', 'about',
      'checkUpdate', 'setAutoCheck', 'restartToUpdate', 'devTools']) {
      expect(channels(), `正本里少了 ${a}`).toContain(a);
    }
  });
});

describe('浏览器模式里没有桥', () => {
  it('取不到就是 null——网页据此判断该不该摆那些按钮', () => {
    // 这个测试跑在 node 环境（web/src/lib 下都是纯函数档），window 压根不存在
    expect(desktopBridge()).toBeNull();
  });
});
