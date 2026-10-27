import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesktopPaths } from './paths.js';
import { readDesktopSettings, writeDesktopSettings, type DesktopSettings } from './settings.js';
import { askFirstRun, validateDataRoot, type FirstRunDialog } from './firstRun.js';
import { decideLink } from './links.js';
import { decidePermission } from './permissions.js';
import { LogSink } from './logs.js';
import { pickFreePort } from './ports.js';
import { startServer, waitUntilHealthy, describeLaunchFailure, type ChildHandle } from './serverChild.js';
import { buildMenuTemplate } from './menu.js';
import {
  createUpdater, loadAutoCheck, saveAutoCheck, shouldEnableUpdater, updateChannelFromPackage,
  type AutoUpdaterLike, type Updater,
} from './updater.js';
import { APP_ID, PRODUCT_NAME } from './product.js';

const USER_DATA = join(app.getPath('appData'), 'zhengyin');
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
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

function buildMenu(): void {
  const readyVersion = updater?.versionReady() ?? null;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    openDataFolder: () => { void shell.openPath(dataRoot); },
    changeDataFolder: () => { void changeDataFolder(); },
    reload: () => win?.reload(),
    quit: () => app.quit(),
    about: () => {
      void dialog.showMessageBox({
        type: 'info',
        title: `关于${PRODUCT_NAME}`,
        message: `${PRODUCT_NAME} ${app.getVersion()}`,
        detail: '美式发音逐音素评测与笔记。数据全部在这台机器上。',
      });
    },
    updater: updater ? {
      check: () => updater?.checkManual(),
      restart: () => updater?.restartToInstall(),
      autoCheck: loadAutoCheck(PREFS_FILE),
      toggleAutoCheck: (v) => updater?.setAutoCheck(v),
      readyVersion,
    } : null,
    devTools: app.isPackaged ? null : () => win?.webContents.openDevTools(),
  })));
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
  writeDesktopSettings(SETTINGS_FILE, { ...settings, appRoot: r.filePaths[0] });
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
    child = await startServer({ paths, port, log, version: app.getVersion() });
    child.onExit((code, killedByUs, launchError) => {
      if (killedByUs) return;
      const why = launchError ? describeLaunchFailure(launchError) : `退出码 ${code ?? '未知'}`;
      void dialog.showMessageBox({
        type: 'error',
        title: `${PRODUCT_NAME}的后台服务退出了`,
        message: why,
        detail: `日志：${paths.logFile}`,
      });
    });

    const healthy = await waitUntilHealthy(port);
    installPermissions();
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

    const channel = updateChannelFromPackage(pkg());
    if (shouldEnableUpdater({ isPackaged: app.isPackaged, platform: process.platform, channel })) {
      const { autoUpdater } = electronUpdater;
      updater = createUpdater(autoUpdater as unknown as AutoUpdaterLike, {
        log: (m) => log.write(`[updater] ${m}\n`),
        balloon: (title, content) => { void dialog.showMessageBox({ type: 'info', title, message: content }); },
        showError: (m) => { void dialog.showMessageBox({ type: 'error', title: `${PRODUCT_NAME}更新`, message: m }); },
        setTimer: (cb, ms) => setTimeout(cb, ms),
        readAutoCheck: () => loadAutoCheck(PREFS_FILE),
        writeAutoCheck: (v) => saveAutoCheck(PREFS_FILE, v),
        onChange: () => buildMenu(),
      });
      updater.scheduleAuto();
    }
    buildMenu();
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
