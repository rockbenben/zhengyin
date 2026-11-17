/**
 * 桌面外壳跟网页之间那根线的形状。
 *
 * 菜单栏已经撤了。Electron 那条「文件 / 帮助」原生菜单上的动作——打开数据文件夹、
 * 更换数据文件夹、检查更新、退出——现在改由网页自己摆：网页通过 preload 递过来的
 * `window.zhengyinDesktop` 调它们。菜单那份模板（`menu.ts`）已经删掉，
 * 这份文件是那些动作**唯一的正本**。
 *
 * **频道名为什么会有两份**：preload 跑在沙箱里，而沙箱里的 `require` 只认白名单
 * （electron / events / timers / url），**取不到旁边的文件**——所以 preload 那份
 * 频道名只能是抄的。抄错不会报错，只会调不通（点了没反应），所以
 * `bridge.test.ts` 盯着两份对不对得上。网页那边（`web/src/lib/desktop.ts`）
 * 抄的是**动作名**，那份由网页侧的守卫盯着。
 */

/** 主进程 ⇄ 渲染进程之间的频道名。正本在这儿，preload 抄一份；网页抄的是动作名。 */
export const CHANNEL = {
  /** 渲染进程问：这个应用现在是什么状态（版本、有没有更新器、自动检查开没开） */
  state: 'desktop:state',
  /** 打开数据文件夹（系统文件管理器） */
  openDataFolder: 'desktop:open-data-folder',
  /** 换数据文件夹，选完要重启 */
  changeDataFolder: 'desktop:change-data-folder',
  /** 重新加载窗口 */
  reload: 'desktop:reload',
  /** 退出应用 */
  quit: 'desktop:quit',
  /** 「关于正音」对话框 */
  about: 'desktop:about',
  /** 手动检查更新 */
  checkUpdate: 'desktop:check-update',
  /** 自动检查更新开关 */
  setAutoCheck: 'desktop:set-auto-check',
  /** 重启以装上已经下好的更新 */
  restartToUpdate: 'desktop:restart-to-update',
  /** 打开开发者工具（开发模式） */
  devTools: 'desktop:dev-tools',
} as const;

export type ChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

/**
 * 更新器现在停在哪一格。
 *
 * **这是给网页看的**：网页得知道「正在检查」「正在下载」「已是最新」，
 * 否则点完「检查更新」界面上一动不动——用户分不清"没反应"和"没有新版"。
 */
export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

/**
 * 网页看到的那份「这个应用现在是什么状态」。
 *
 * 网页不自己判断有没有更新器——**能不能更新取决于打包形态**（只有 Windows 的
 * NSIS 安装版有自动更新，zip 免安装版没有），这个事实只有主进程知道。
 */
export interface DesktopState {
  /** 应用版本 */
  version: string;
  /** 有没有更新器。没有的话网页就不摆「检查更新」那几项 */
  updater: boolean;
  /** 开发者工具。开发模式才有 */
  devTools: boolean;
  /** 自动检查更新开着吗 */
  autoCheck: boolean;
  /** 已经下好、等着重启安装的版本；没有就是 null */
  updateReady: string | null;
  /** 更新器现在在干什么。没有更新器就是 null */
  updateState: UpdateState | null;
}

/**
 * 这些动作里，哪些是**用户真正要用的**。
 *
 * 原来菜单栏上的每一项都在这儿，包括「重新加载」和「退出」——菜单里有的，
 * 应用里就得有，不然就等于悄悄少给了功能。至于「开发者工具」，它跟更新器一样
 * 是**按形态有没有**的（只在开发模式），所以单独一档。
 *
 * 用清单而不是散落在 main.ts 的各个 handler 里，是因为**网页那边要照着它摆按钮**：
 * 摆出来的和真能做的得是一份。
 */
export const USER_ACTIONS = [
  'openDataFolder',
  'changeDataFolder',
  'reload',
  'quit',
  'about',
] as const;

/** 只有打包的 Windows NSIS 版才有（zip 免安装版没有可覆盖的安装根） */
export const UPDATER_ACTIONS = [
  'checkUpdate',
  'setAutoCheck',
  'restartToUpdate',
] as const;

/** 开发模式才有 */
export const DEV_ACTIONS = ['devTools'] as const;
