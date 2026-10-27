import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FirstRunChoice =
  | { kind: 'fresh' }
  | { kind: 'existing'; dir: string }
  | { kind: 'backup'; file: string };

export interface FirstRunDialog {
  showMessageBox(opts: object): Promise<{ response: number }>;
  showOpenDialog(opts: object): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** 像不像一个正音数据根：有 data/、notes/ 或档案模板之一 */
export function validateDataRoot(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return '选中的不是一个文件夹。';
  } catch {
    return '这个文件夹读不到。';
  }
  for (const marker of ['data', 'notes', '发音档案.template.md']) {
    if (existsSync(join(dir, marker))) return null;
  }
  return '这个文件夹不像正音的数据根（里面没有 data/、notes/ 或 发音档案.template.md）。';
}

export async function askFirstRun(dialog: FirstRunDialog): Promise<FirstRunChoice> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '正音',
    message: '要使用已有的正音数据吗？',
    detail: '可以选旧的「正音」文件夹（数据原样继续用），也可以导入备份文件，或者从空白开始。',
    buttons: ['选旧文件夹', '导入备份', '全新开始'],
    defaultId: 2,
    cancelId: 2,
  });

  if (response === 0) {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { kind: 'fresh' };
    const bad = validateDataRoot(r.filePaths[0]);
    if (bad) {
      await dialog.showMessageBox({ type: 'error', title: '这个文件夹用不了', message: bad });
      return askFirstRun(dialog);
    }
    return { kind: 'existing', dir: r.filePaths[0] };
  }

  if (response === 1) {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '备份', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { kind: 'fresh' };
    return { kind: 'backup', file: r.filePaths[0] };
  }

  return { kind: 'fresh' };
}
