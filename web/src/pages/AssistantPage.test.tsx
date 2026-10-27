import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AssistantPage from './AssistantPage';
import { api } from '../api';
import type { AiStatusInfo, ChatMessage } from '../types';

const ready: AiStatusInfo = {
  configured: true, consent: true, mode: 'api', provider: '接口·m', reason: null,
};

const draw = (entries = ['/assistant']) => render(
  <MemoryRouter initialEntries={entries}><AssistantPage /></MemoryRouter>,
);

beforeEach(() => vi.restoreAllMocks());

describe('AI 助教', () => {
  it('没接上 AI 时输入框是禁用的，并给设置入口', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({
      configured: false, consent: false, mode: 'api', provider: null, reason: '还没选接口',
    });
    vi.spyOn(api, 'aiChat').mockResolvedValue({ messages: [] });
    draw();

    expect(await screen.findByText(/先接上 AI/)).toBeTruthy();
    expect((screen.getByLabelText('对 AI 助教说') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: /去设置/ })).toBeTruthy();
  });

  it('历史里助教的话按 markdown 渲染', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'l 怎么发？', at: 't1' },
      { role: 'assistant', content: '## 结论\n舌尖顶住上齿龈。', at: 't2' },
    ];
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiChat').mockResolvedValue({ messages: history });
    draw();

    expect(await screen.findByRole('heading', { name: '结论' })).toBeTruthy();
    expect(screen.getByText('l 怎么发？')).toBeTruthy();
    expect((screen.getByLabelText('对 AI 助教说') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('发一条消息，回复和来源都上屏', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiChat').mockResolvedValue({ messages: [] });
    const send = vi.spyOn(api, 'sendAiChat').mockResolvedValue({
      reply: '## 回答\n先捏住鼻子发。',
      sources: [{ id: 'l-vs-n', title: 'l/n 混淆' }],
      provider: '接口·m',
    });
    draw();

    fireEvent.change(await screen.findByLabelText('对 AI 助教说'), { target: { value: 'l 怎么发？' } });
    fireEvent.click(screen.getByRole('button', { name: /发\s*送/ }));

    expect(await screen.findByRole('heading', { name: '回答' })).toBeTruthy();
    expect(screen.getByText(/先捏住鼻子发/)).toBeTruthy();
    expect(screen.getByText('l/n 混淆')).toBeTruthy();
    expect(send).toHaveBeenCalledWith('l 怎么发？', undefined);
  });

  it('发送失败时撤回上屏的问题，把输入还回去', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiChat').mockResolvedValue({ messages: [] });
    vi.spyOn(api, 'sendAiChat').mockRejectedValue(new Error('服务商故障（500）'));
    draw();

    fireEvent.change(await screen.findByLabelText('对 AI 助教说'), { target: { value: 'l 怎么发？' } });
    fireEvent.click(screen.getByRole('button', { name: /发\s*送/ }));

    expect(await screen.findByText(/服务商故障/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.chat-msg.user')).toBeNull());
    expect((screen.getByLabelText('对 AI 助教说') as HTMLTextAreaElement).value).toBe('l 怎么发？');
  });

  it('命令行模式说清每条消息都会重新启动一次', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...ready, mode: 'cli', provider: 'claude' });
    vi.spyOn(api, 'aiChat').mockResolvedValue({ messages: [] });
    draw();

    expect(await screen.findByText(/重新启动一次/)).toBeTruthy();
  });

  it('从词条页带着 word 进来时，输入框先填好这一问', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiChat').mockResolvedValue({ messages: [] });
    draw(['/assistant?word=click']);

    const input = await screen.findByLabelText('对 AI 助教说') as HTMLTextAreaElement;
    expect(input.value).toContain('click');
    expect(screen.getByText(/这一问会带上词条「click」/)).toBeTruthy();
  });

  it('清空对话只清当前用户的记录', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiChat').mockResolvedValue({
      messages: [{ role: 'user', content: '旧消息', at: 't' }],
    });
    const clear = vi.spyOn(api, 'clearAiChat').mockResolvedValue({ ok: true });
    draw();

    expect(await screen.findByText('旧消息')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /清\s*空/ }));
    const buttons = await screen.findAllByRole('button', { name: /清\s*空/ });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(await screen.findByText(/可以问某个音怎么发/)).toBeTruthy();
  });
});
