import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NoteEditor from './NoteEditor';
import { api } from '../api';
import type { NoteDraft } from '../types';

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  title: 'l 和 n',
  scope: 'phoneme',
  values: ['l', 'n'],
  contrasts: [],
  body: '## 自检法\n捏鼻。\n\n## 对比训练\n老 / 脑，再练 light / night。',
  ...over,
});

function draw(over: Partial<NoteDraft> = {}, onClose = vi.fn(), onSaved = vi.fn()) {
  render(<NoteEditor draft={draft(over)} open onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

beforeEach(() => vi.restoreAllMocks());

describe('NoteEditor', () => {
  it('按草稿填好字段', async () => {
    draw();
    expect((await screen.findByLabelText('标题') as HTMLInputElement).value).toBe('l 和 n');
    expect((screen.getByLabelText('适用范围') as HTMLInputElement).value).toBe('l, n');
    expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toContain('捏鼻');
    expect((screen.getByRole('radio', { name: '讲这个音' }) as HTMLInputElement).checked).toBe(true);
  });

  it('保存时把逗号分隔的取值拆成数组', async () => {
    const save = vi.spyOn(api, 'saveNote').mockResolvedValue({ id: 'ai-phoneme-l-n', title: 'l 和 n', file: 'ai-phoneme-l-n.md' });
    const { onClose, onSaved } = draw();

    fireEvent.change(screen.getByLabelText('适用范围'), { target: { value: 'l，n' } });
    fireEvent.change(screen.getByLabelText('错法音素'), { target: { value: 's, f' } });
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({
      scope: 'phoneme', values: ['l', 'n'], contrasts: ['s', 'f'],
    });
    expect(onSaved).toHaveBeenCalledWith({ id: 'ai-phoneme-l-n', title: 'l 和 n', file: 'ai-phoneme-l-n.md' });
    expect(onClose).toHaveBeenCalled();
  });

  it('切成讲词的笔记时，带空格的短语不被拆开', async () => {
    const save = vi.spyOn(api, 'saveNote').mockResolvedValue({ id: 'x', title: 'x', file: 'x.md' });
    draw();

    fireEvent.click(screen.getByRole('radio', { name: '讲这个词' }));
    fireEvent.change(screen.getByLabelText('适用范围'), { target: { value: 'machine, machine learning' } });
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].values).toEqual(['machine', 'machine learning']);
    expect(save.mock.calls[0][0].scope).toBe('word');
  });

  it('服务端校验不过时把原话摆出来，不关窗口', async () => {
    vi.spyOn(api, 'saveNote').mockRejectedValue(new Error('笔记没通过校验：\n[notes] 缺「自检法」'));
    const { onClose } = draw();

    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    expect(await screen.findByText(/没保存成功/)).toBeTruthy();
    expect(screen.getByText(/缺「自检法」/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('正文旁边有渲染后的预览', async () => {
    draw();
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '## 自检法\n捏住鼻子发。' } });
    expect(await screen.findByRole('heading', { name: '自检法' })).toBeTruthy();
  });
});
