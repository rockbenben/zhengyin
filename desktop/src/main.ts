import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, session, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesktopPaths, desktopUserData } from './paths.js';
import { isPreference, readDesktopSettings, writeDesktopSettings, type DesktopSettings } from './settings.js';
import { askFirstRun, askLockedDataRoot, validateDataRoot, type FirstRunDialog } from './firstRun.js';
import { decideLink } from './links.js';
import { decidePermission } from './permissions.js';
import { LogSink } from './logs.js';
import { pickFreePort } from './ports.js';
import { startServer, waitUntilHealthy, describeLaunchFailure, type ChildHandle } from './serverChild.js';
import { CHANNEL, type DesktopState } from './bridge.js';
import {
  createUpdater, loadAutoCheck, saveAutoCheck, shouldEnableUpdater, updateChannelFromPackage,
  type AutoUpdaterLike, type Updater,
} from './updater.js';
import { APP_ID, PRODUCT_NAME } from './product.js';

const USER_DATA = desktopUserData(app.getPath('appData'), app.commandLine.getSwitchValue('user-data-dir'));
mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);
app.setAppUserModelId(APP_ID);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const ICON = join(here, '..', 'build', 'icon.png');
const SETTINGS_FILE = join(USER_DATA, 'desktop-settings.json');
const PREFS_FILE = join(USER_DATA, 'update-prefs.json');

let win: BrowserWindow | null = null;
let child: ChildHandle | null = null;
let updater: Updater | null = null;
let settings: DesktopSettings | null = null;
let dataRoot = USER_DATA;
let port = 0;
let quitting = false;
/**
 * 保活的通知实例。
 *
 * **为什么必须留着它**：Windows 上通知的点击激活走的是**实例事件**，实例一旦被
 * GC 掉，那个事件就再也收不到——Electron 自己的 `Notification.handleActivation()`
 * 文档里明确列了这一条（"Notification object was garbage collected"）。
 * 于是「点这条通知就能装上」会变成点了没反应；而 `autoInstallOnAppQuit` 是关的，
 * 正常退出也不会装——**已经下好的更新就永远卡在那里**。
 */
let pendingNotification: Notification | null = null;
/**
 * 正音自己的版本号。
 *
 * **不用 `app.getVersion()`**：开发模式下 Electron 读不到应用自己的 package.json，
 * 那个调用给的是 **Electron 的版本**（如 45.3.3）——界面上写「正音 45.3.3」是句假话。
 * `desktop/package.json` 里那份才是正音的版本，打包时 electron-builder 也用它。
 */
let appVersion = '';

function pkg(): { version: string; zhengyinChannel?: string } {
  return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string; zhengyinChannel?: string };
}

function openWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function errorPage(logFile: string): string {
  return `<meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;line-height:1.7">
<h1>${PRODUCT_NAME}没能启动后台服务</h1>
<p>日志在：<code>${logFile}</code></p>
<p>把它发出来就能定位。修好之后重新打开${PRODUCT_NAME}。</p></body>`;
}

function createWindow(healthy: boolean): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: ICON,
    show: false,
    // preload 是网页跟主进程之间唯一的通道：菜单栏撤了以后，原来挂在菜单上的
    // 动作（打开数据文件夹、检查更新……）由网页自己摆，点下来走的就是这里。
    // 它必须是 .cjs —— 沙箱渲染进程不加载 ESM preload（见 preload.cts 的说明）。
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());

  const origin = `http://127.0.0.1:${port}`;
  const handOff = (raw: string): void => {
    const d = decideLink(raw, origin);
    if (d.kind === 'external') void shell.openExternal(d.url).catch(() => undefined);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    handOff(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (decideLink(url, origin).kind === 'stay') return;
    e.preventDefault();
    handOff(url);
  });
  win.on('closed', () => { win = null; });

  const target = healthy
    ? origin
    : `data:text/html;charset=utf-8,${encodeURIComponent(errorPage(join(USER_DATA, 'logs', 'server.log')))}`;
  void win.loadURL(target);
}

function installPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(decidePermission(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => decidePermission(permission));
}

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: `关于${PRODUCT_NAME}`,
    message: `${PRODUCT_NAME} ${appVersion}`,
    detail: '美式发音逐音素评测与笔记。数据全部在这台机器上。',
  });
}

/**
 * 菜单栏撤了以后，原来挂在菜单上的动作改由网页调用。
 *
 * 网页那边拿到的是 preload 递过来的 `window.zhengyinDesktop`，一个方法对应这里
 * 一个 handler。**动作清单的正本是 bridge.ts**，这里只管实现。
 *
 * 动作 handler 一律不回值：这些动作的结果要么是界面自己变了（重新加载、退出），
 * 要么是弹了个对话框（换数据文件夹、关于），网页那边不需要等一个结果。
 * （`CHANNEL.state` 和 `CHANNEL.preferences` 是查询，要回值，不在这条里。）
 */
function registerIpc(): void {
  const state = (): DesktopState => ({
    version: appVersion,
    // 有没有更新器取决于打包形态（只有 Windows 的 NSIS 安装版有），网页不自己判断
    updater: updater !== null,
    devTools: !app.isPackaged,
    autoCheck: loadAutoCheck(PREFS_FILE),
    updateReady: updater?.versionReady() ?? null,
    // 更新器现在在干什么。网页据此说「正在检查」「已是最新」。
    // 「重启以完成更新」能不能按看的是 updateReady，不是这一格——状态会漂
    // （见 updater.ts 的 restartToInstall）。
    updateState: updater?.state() ?? null,
  });

  ipcMain.handle(CHANNEL.state, () => state());
  ipcMain.handle(CHANNEL.preferences, () => settings?.preferences ?? {});
  ipcMain.handle(CHANNEL.setPreference, (event, key: unknown, value: unknown) => {
    if (!settings || event.sender !== win?.webContents
        || !event.senderFrame?.url.startsWith(`http://127.0.0.1:${port}/`)) return;
    if (typeof value !== 'string' || !isPreference(key, value)) return;
    const next = { ...settings, preferences: { ...settings.preferences, [key]: value } };
    writeDesktopSettings(SETTINGS_FILE, next);
    settings = next;
  });
  ipcMain.handle(CHANNEL.openDataFolder, () => { void shell.openPath(dataRoot); });
  ipcMain.handle(CHANNEL.changeDataFolder, () => { void changeDataFolder(); });
  ipcMain.handle(CHANNEL.reload, () => { win?.reload(); });
  ipcMain.handle(CHANNEL.quit, () => { app.quit(); });
  ipcMain.handle(CHANNEL.about, () => { showAbout(); });
  ipcMain.handle(CHANNEL.checkUpdate, () => { updater?.checkManual(); });
  ipcMain.handle(CHANNEL.setAutoCheck, (_e, v: unknown) => { updater?.setAutoCheck(v === true); });
  ipcMain.handle(CHANNEL.restartToUpdate, () => { updater?.restartToInstall(); });
  ipcMain.handle(CHANNEL.devTools, () => { win?.webContents.openDevTools(); });
}

async function changeDataFolder(): Promise<void> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  const bad = validateDataRoot(r.filePaths[0]);
  if (bad) {
    await dialog.showMessageBox({ type: 'error', title: '这个文件夹用不了', message: bad });
    return;
  }
  if (!settings) return;
  const next = { ...settings, appRoot: r.filePaths[0] };
  writeDesktopSettings(SETTINGS_FILE, next);
  settings = next;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '更换数据文件夹',
    message: '要现在重启吗？',
    buttons: ['重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    app.relaunch();
    app.quit();
  }
}

async function bootstrap(): Promise<void> {
  settings = readDesktopSettings(SETTINGS_FILE);
  let backupFile: string | null = null;

  // 没有菜单栏。Electron 默认那条「文件 / 帮助」在 Windows 上是窗口的一部分，
  // 设成 null 就整条撤掉；窗口的标题栏（最小化/最大化/关闭）不受影响。
  // 原来挂在上面的动作改成由网页自己摆，通道是 preload（见 bridge.ts）。
  Menu.setApplicationMenu(null);

  // 界面上要写的版本号。正音自己那份，不是 Electron 的。
  appVersion = pkg().version;

  if (!settings) {
    const choice = await askFirstRun(dialog as unknown as FirstRunDialog);
    if (choice.kind === 'existing') {
      settings = { schemaVersion: 1, appRoot: choice.dir };
    } else if (choice.kind === 'backup') {
      settings = { schemaVersion: 1, appRoot: join(USER_DATA, 'app') };
      backupFile = choice.file;
    } else {
      settings = { schemaVersion: 1, appRoot: join(USER_DATA, 'app') };
    }
    writeDesktopSettings(SETTINGS_FILE, settings);
  }

  const paths = resolveDesktopPaths(
    {
      isPackaged: app.isPackaged,
      resourcesPath: (process as NodeJS.Process & { resourcesPath: string }).resourcesPath,
      userData: USER_DATA,
      repoRoot,
    },
    { appRoot: settings.appRoot },
  );
  dataRoot = paths.appRoot;
  const log = new LogSink(paths.logFile, 2 * 1024 * 1024);
  port = await pickFreePort();

  try {
    child = await startServer({ paths, port, log, version: appVersion });
    let lockFailed = false;
    child.onExit((code, killedByUs, launchError) => {
      if (killedByUs) return;
      if (launchError?.code === 'DATA_LOCK_BUSY') {
        lockFailed = true;
        void askLockedDataRoot(dialog as unknown as FirstRunDialog, launchError.message, dataRoot).then((dir) => {
          if (dir && settings) {
            writeDesktopSettings(SETTINGS_FILE, { ...settings, appRoot: dir });
            app.relaunch();
          }
          app.quit();
        }).catch(() => app.quit());
        return;
      }
      const why = launchError ? describeLaunchFailure(launchError) : `退出码 ${code ?? '未知'}`;
      void dialog.showMessageBox({
        type: 'error',
        title: `${PRODUCT_NAME}的后台服务退出了`,
        message: why,
        detail: `日志：${paths.logFile}`,
      });
    });

    const healthy = await waitUntilHealthy(port, { shouldStop: () => lockFailed });
    if (lockFailed) return;
    installPermissions();

    // 「点通知装更新」不能只靠实例事件：实例被 GC 掉就收不到激活
    // （Electron 的 `handleActivation` 文档里就写着这一条）。
    // 它还管另外两种情况：冷启动（从通知点开应用）和通知中心里
    // 没有内存副本的残留通知——那两种靠实例事件更收不到。
    if (process.platform === 'win32' && Notification.isSupported()) {
      Notification.handleActivation(() => { updater?.restartToInstall(); });
    }

    // 更新器要在开窗**之前**起来：网页一打开就会问「有没有更新器」，
    // 那时候这个答案得是对的（晚一步的话，头一次问会得到「没有」，
    // 更新那一档得等网页下一次三秒轮询才冒出来）。
    const channel = updateChannelFromPackage(pkg());
    if (shouldEnableUpdater({ isPackaged: app.isPackaged, platform: process.platform, channel })) {
      const { autoUpdater } = electronUpdater;
      updater = createUpdater(autoUpdater as unknown as AutoUpdaterLike, {
        log: (m) => log.write(`[updater] ${m}\n`),
        // 更新下好了 → 弹一条系统通知，点它就装。
        //
        // **不用对话框**：对话框是模态的，会把人正在进行的录音打断。
        // 通知不挡界面，而「重启以完成更新」这个按钮本身在应用里
        // （设置页的「桌面版」那一段），通知只是把它叫醒。
        balloon: (title, content) => {
          if (!Notification.isSupported()) return;
          const n = new Notification({ title, body: content });
          n.on('click', () => { updater?.restartToInstall(); });
          pendingNotification = n;   // 保活：实例被回收就收不到点击了
          n.show();
        },
        showError: (m) => { void dialog.showMessageBox({ type: 'error', title: `${PRODUCT_NAME}更新`, message: m }); },
        setTimer: (cb, ms) => setTimeout(cb, ms),
        readAutoCheck: () => loadAutoCheck(PREFS_FILE),
        writeAutoCheck: (v) => saveAutoCheck(PREFS_FILE, v),
        // 以前这里是重建菜单（菜单上那个「自动检查更新」勾要跟着变）。
        // 现在没有菜单可重建了：网页自己来问状态（CHANNEL.state），
        // 所以这里不用做任何事。
        onChange: () => {},
      });
      updater.scheduleAuto();
    }

    registerIpc();
    createWindow(healthy);

    if (backupFile) {
      if (!healthy) {
        await dialog.showMessageBox({
          type: 'warning',
          title: '备份没有导入成功',
          message: '后台服务没起来，所以没有导入。',
          detail: '修好服务后，在「设置 → 搬家」里再试一次。',
        });
      } else {
        const body = readFileSync(backupFile, 'utf8');
        const res = await fetch(`http://127.0.0.1:${port}/api/backup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (!res.ok) {
          await dialog.showMessageBox({
            type: 'warning',
            title: '备份没有导入成功',
            message: `服务返回 ${res.status}`,
            detail: '打开应用后可以在「设置 → 搬家」里再试一次。',
          });
        }
      }
    }
  } catch (e) {
    void dialog.showMessageBox({
      type: 'error',
      title: `${PRODUCT_NAME}启动失败`,
      message: (e as Error).message,
      detail: `日志：${paths.logFile}`,
    });
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openWindow());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void (child?.stop() ?? Promise.resolve()).finally(() => app.quit());
  });
  void app.whenReady().then(bootstrap);
}
