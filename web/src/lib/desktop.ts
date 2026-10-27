/**
 * 桌面外壳递过来的那点能力。
 *
 * 浏览器模式（`npm start` / `npm run go`）里根本没有它——网页跑在普通浏览器里，
 * 够不着主进程。桌面版里 preload 把它挂在 `window.zhengyinDesktop` 上
 * （`desktop/src/preload.cts`），网页这一侧是**抄**的：两个包各编各的，
 * 为一个只有十来行的接口另起一个共享包不值当。抄的那份由
 * `web/src/lib/desktop.test.ts` 盯着——抄错不会报错，只会让按钮点了没反应。
 */

/** 这个应用现在是什么状态。网页不自己判断「有没有更新器」——那取决于打包形态。 */
export interface DesktopState {
  version: string;
  /** 有没有更新器。只有打包的 Windows NSIS 安装版有 */
  updater: boolean;
  /** 开发者工具。开发模式才有 */
  devTools: boolean;
  /** 自动检查更新开着吗 */
  autoCheck: boolean;
  /** 已经下好、等着重启安装的版本；没有就是 null */
  updateReady: string | null;
}

/**
 * 原来那条菜单栏上的动作，现在是这些方法。
 *
 * 菜单撤了，但菜单里有的这里都得有——少一个就等于悄悄少给了功能。
 */
export interface DesktopBridge {
  state(): Promise<DesktopState>;
  openDataFolder(): Promise<void>;
  changeDataFolder(): Promise<void>;
  reload(): Promise<void>;
  quit(): Promise<void>;
  about(): Promise<void>;
  checkUpdate(): Promise<void>;
  setAutoCheck(v: boolean): Promise<void>;
  restartToUpdate(): Promise<void>;
  devTools(): Promise<void>;
}

declare global {
  interface Window {
    /** preload 挂上来的桥。浏览器模式里压根没有这个键 */
    zhengyinDesktop?: DesktopBridge;
  }
}

/**
 * 桌面外壳在不在。浏览器模式恒为 null。
 *
 * **判据是桥在不在，不是服务端那个 `runtime.desktop`**：服务端那个标志说的是
 * 「这个服务是被桌面外壳拉起来的」，而网页能调主进程，靠的是 preload 挂的桥。
 * 两者在桌面版里同时成立，但只有后者能回答「按钮点了有没有反应」。
 */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.zhengyinDesktop ?? null;
}
