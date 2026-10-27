import type { MenuItemConstructorOptions } from 'electron';

export interface MenuOps {
  openDataFolder: () => void;
  changeDataFolder: () => void;
  reload: () => void;
  quit: () => void;
  about: () => void;
  devTools?: (() => void) | null;
  updater: {
    check: () => void;
    restart: () => void;
    autoCheck: boolean;
    toggleAutoCheck: (v: boolean) => void;
    readyVersion: string | null;
  } | null;
}

export function buildMenuTemplate(o: MenuOps): MenuItemConstructorOptions[] {
  const file: MenuItemConstructorOptions[] = [
    { label: '打开数据文件夹', click: o.openDataFolder },
    { label: '更换数据文件夹…', click: o.changeDataFolder },
    { type: 'separator' },
    { label: '重新加载', click: o.reload },
    { type: 'separator' },
    { label: '退出', click: o.quit },
  ];

  const help: MenuItemConstructorOptions[] = [];
  if (o.updater) {
    help.push(
      { label: '检查更新', click: o.updater.check },
      {
        label: '自动检查更新',
        type: 'checkbox',
        checked: o.updater.autoCheck,
        click: (item) => o.updater?.toggleAutoCheck(item.checked),
      },
    );
    if (o.updater.readyVersion) {
      help.push({ label: `重启以完成更新 v${o.updater.readyVersion}`, click: o.updater.restart });
    }
    help.push({ type: 'separator' });
  }
  help.push({ label: '关于正音', click: o.about });
  if (o.devTools) help.push({ type: 'separator' }, { label: '开发者工具', click: o.devTools });

  return [
    { label: '文件', submenu: file },
    { label: '帮助', submenu: help },
  ];
}
