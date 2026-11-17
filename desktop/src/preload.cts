/**
 * 沙箱 preload：把主进程的动作递给网页。
 *
 * 网页要调主进程，只能走 preload 递过来的 `window.zhengyinDesktop`——
 * 渲染进程是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，
 * 网页自己够不着 `ipcRenderer`。
 *
 * **这个文件必须是 CommonJS（`.cts` → `.cjs`），而且不许 import 旁边的文件。**
 * 两个原因都是硬约束：
 *   · 沙箱渲染进程不加载 ESM preload（必须 `.cjs`）；
 *   · 沙箱里的 `require` 只认白名单（electron / events / timers / url），
 *     **取不到相对路径**，所以频道名没法从 `bridge.ts` import 过来。
 *
 * 于是频道名在这儿抄了一遍。正本是 `desktop/src/bridge.ts`，
 * 抄本对不对得上由 `bridge.test.ts` 盯着——抄错不会报错，只会让按钮点了没反应。
 */
import { contextBridge, ipcRenderer } from 'electron';

/** 抄自 desktop/src/bridge.ts（见本文件开头的说明：抄不了，只能抄） */
const CHANNEL = {
  state: 'desktop:state',
  preferences: 'desktop:preferences',
  setPreference: 'desktop:set-preference',
  openDataFolder: 'desktop:open-data-folder',
  changeDataFolder: 'desktop:change-data-folder',
  reload: 'desktop:reload',
  quit: 'desktop:quit',
  about: 'desktop:about',
  checkUpdate: 'desktop:check-update',
  setAutoCheck: 'desktop:set-auto-check',
  restartToUpdate: 'desktop:restart-to-update',
  devTools: 'desktop:dev-tools',
} as const;

contextBridge.exposeInMainWorld('zhengyinDesktop', {
  /** 这个应用现在是什么状态：版本、有没有更新器、自动检查开没开 */
  state: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.state),
  preferences: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.preferences),
  setPreference: (key: string, value: string): Promise<void> => ipcRenderer.invoke(CHANNEL.setPreference, key, value),

  // ── 原来菜单栏「文件」里的 ──
  openDataFolder: (): Promise<void> => ipcRenderer.invoke(CHANNEL.openDataFolder),
  changeDataFolder: (): Promise<void> => ipcRenderer.invoke(CHANNEL.changeDataFolder),
  reload: (): Promise<void> => ipcRenderer.invoke(CHANNEL.reload),
  quit: (): Promise<void> => ipcRenderer.invoke(CHANNEL.quit),

  // ── 原来菜单栏「帮助」里的 ──
  about: (): Promise<void> => ipcRenderer.invoke(CHANNEL.about),

  // ── 更新（只有 NSIS 安装版有） ──
  checkUpdate: (): Promise<void> => ipcRenderer.invoke(CHANNEL.checkUpdate),
  setAutoCheck: (v: boolean): Promise<void> => ipcRenderer.invoke(CHANNEL.setAutoCheck, v),
  restartToUpdate: (): Promise<void> => ipcRenderer.invoke(CHANNEL.restartToUpdate),

  // ── 开发模式才有 ──
  devTools: (): Promise<void> => ipcRenderer.invoke(CHANNEL.devTools),
});
