import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OrganizePage from './OrganizePage';
import { api } from '../api';
import type { AgentStatusInfo, AiStatusInfo } from '../types';

const ready: AiStatusInfo = {
  configured: true, consent: true, mode: 'cli', provider: 'claude', reason: null,
};

const idleStatus = (over: Partial<AgentStatusInfo> = {}): AgentStatusInfo => ({
  state: 'idle', logs: [], startedAt: null, finishedAt: null,
  changed: null, outOfScope: [], noteWarnings: [], autoOk: null,
  runId: null, error: null, cancelling: false,
  ...over,
});

const draw = () => render(
  <MemoryRouter><OrganizePage pollMs={10} /></MemoryRouter>,
);

beforeEach(() => vi.restoreAllMocks());

describe('AI 整理', () => {
  it('接口模式可以整理，并在确认框说明资料发送与保存方式', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...ready, mode: 'api', provider: '接口·m' });
    vi.spyOn(api, 'aiAgentStatus').mockResolvedValue(idleStatus());
    draw();

    fireEvent.click(await screen.findByRole('button', { name: '开始整理' }));
    expect(await screen.findByText(/将发送当前用户完整发音档案/)).toBeTruthy();
    expect(screen.getByText(/应用校验返回的修改方案后保存/)).toBeTruthy();
  });

  it('三种任务都摆出来；自定义没写说明时不能开始', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiAgentStatus').mockResolvedValue(idleStatus());
    draw();

    expect(await screen.findByText('整理发音记录')).toBeTruthy();
    expect(screen.getByText('更新发音档案')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /自定义/ }));
    expect(screen.getByLabelText('自定义整理说明')).toBeTruthy();
    expect((screen.getByRole('button', { name: '开始整理' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('确认后开始整理，跑完列出改了哪些文件', async () => {
    let st = idleStatus();
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiAgentStatus').mockImplementation(async () => st);
    const run = vi.spyOn(api, 'aiAgentRun').mockImplementation(async () => {
      st = idleStatus({ state: 'running', startedAt: Date.now(), runId: 'r1', logs: ['正在启动 AI 整理'] });
      return { runId: 'r1' };
    });
    draw();

    fireEvent.click(await screen.findByRole('button', { name: '开始整理' }));
    fireEvent.click(await screen.findByRole('button', { name: /^开\s*始$/ }));

    await waitFor(() => expect(run).toHaveBeenCalledWith('organize', undefined));
    expect(await screen.findByText('正在整理')).toBeTruthy();

    st = idleStatus({
      state: 'done', runId: 'r1', startedAt: 1, finishedAt: 2,
      changed: { added: ['data/notes/ai-test.md'], modified: [], removed: [] },
    });
    expect(await screen.findByText('整理完成')).toBeTruthy();
    expect(screen.getByText('data/notes/ai-test.md')).toBeTruthy();
    expect(screen.getByText('新增（1）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '撤销这次整理' })).toBeTruthy();
  });

  it('撤销把状态换成已撤销', async () => {
    const done = idleStatus({
      state: 'done', runId: 'r1',
      changed: { added: ['data/notes/x.md'], modified: [], removed: [] },
    });
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiAgentStatus').mockResolvedValue(done);
    const undo = vi.spyOn(api, 'aiAgentUndo').mockResolvedValue(idleStatus({ state: 'undone', runId: 'r1', noteWarnings: ['保留后续编辑：x.md'] }));
    draw();

    fireEvent.click(await screen.findByRole('button', { name: '撤销这次整理' }));
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    expect((await screen.findAllByText('已撤销')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '撤销这次整理' })).toBeNull();
    expect(screen.getByText('撤销提示')).toBeTruthy();
    expect(screen.getByText('保留后续编辑：x.md')).toBeTruthy();
    expect(screen.queryByText('这些笔记没通过检查')).toBeNull();
  });

  it('跑的时候显示日志和取消按钮', async () => {
    let st = idleStatus({
      state: 'running', startedAt: Date.now() - 3000, runId: 'r1',
      logs: ['正在准备整理工作副本', '正在启动 AI 整理'],
    });
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiAgentStatus').mockImplementation(async () => st);
    const cancel = vi.spyOn(api, 'aiAgentCancel').mockImplementation(async () => {
      st = idleStatus({ state: 'cancelled', runId: 'r1' });
      return { ok: true };
    });
    draw();

    expect(await screen.findByText(/正在准备整理工作副本/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消整理' }));

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(await screen.findByText('已取消')).toBeTruthy();
  });

  it('越界改动与 AUTO 标记坏掉都单独警告', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(ready);
    vi.spyOn(api, 'aiAgentStatus').mockResolvedValue(idleStatus({
      state: 'error', runId: 'r1', error: 'claude 退出码 1',
      outOfScope: [{ path: 'data/当前用户.txt', kind: 'modified' }],
      autoOk: false,
    }));
    draw();

    expect(await screen.findByText(/检测到整理范围外的文件变动/)).toBeTruthy();
    expect(screen.getByText(/data\/当前用户\.txt（修改）/)).toBeTruthy();
    expect(screen.getByText(/AUTO 统计标记被改坏了/)).toBeTruthy();
    expect(screen.getByText(/claude 退出码 1/)).toBeTruthy();
  });
});

it('接口模式范围外变动不归咎代理，正常校验告警仍保留', async () => {
  vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...ready, mode: 'api' });
  vi.spyOn(api, 'aiAgentStatus').mockResolvedValue(idleStatus({
    state: 'error', runId: 'r1', noteWarnings: ['缺少自检法'],
    outOfScope: [{ path: 'data/当前用户.txt', kind: 'modified' }],
  }));
  draw();
  expect(await screen.findByText('检测到整理范围外的文件变动')).toBeTruthy();
  expect(screen.queryByText(/代理动了/)).toBeNull();
  expect(screen.getByText('这些笔记没通过检查')).toBeTruthy();
  expect(screen.getByText('缺少自检法')).toBeTruthy();
  expect(screen.getByText(/这些不在撤销范围内/)).toBeTruthy();
});
