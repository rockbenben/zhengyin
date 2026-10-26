import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const stub = vi.hoisted(() => ({ imported: [] as unknown[] }));
vi.mock('../api', () => ({
  api: {
    exportBackup: () => Promise.resolve({}),
    importBackup: (data: unknown) => {
      stub.imported.push(data);
      return Promise.resolve({ added: 0, cards: 0, skipped: 0 });
    },
  },
}));

const { default: BackupSetting } = await import('./BackupSetting');

beforeEach(() => { stub.imported = []; });

/**
 * 「导入备份」旁边就是一个文件选择框。选错文件（比如把网页存下来的 .html
 * 当成备份）时，JSON.parse 抛的是英文 SyntaxError——对普通用户等于没说，
 * 而且那句话里连"备份"两个字都没有。
 */
describe('导入备份时选错了文件', () => {
  it('说清是文件选错了，不甩英文解析错误', async () => {
    const { container } = render(<BackupSetting />);
    const input = container.querySelector('input[type=file]')!;
    const bad = new File(['<html>这不是备份</html>'], 'saved-page.html', { type: 'text/html' });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() => expect(document.body.textContent).toMatch(/不是正音的备份/));
    expect(document.body.textContent, '英文解析错误漏到了界面上').not.toMatch(/Unexpected token/i);
    expect(stub.imported, '坏文件不该发给服务端').toEqual([]);
  });
});
