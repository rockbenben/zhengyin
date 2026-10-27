import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AiCoach from './AiCoach';
import { api } from '../api';

const configured = {
  configured: true, consent: true, mode: 'api' as const, provider: '接口·m', reason: null,
};

const draw = (enabled = true) => render(
  <MemoryRouter><AiCoach text="click" enabled={enabled} /></MemoryRouter>,
);

beforeEach(() => vi.restoreAllMocks());

describe('AiCoach', () => {
  it('未配置时给设置入口，不出现点下去才失败的按钮', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({
      configured: false, consent: false, mode: 'api', provider: null, reason: '还没选接口',
    });
    draw();

    expect(await screen.findByText(/先接上 AI/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AI 讲解/ })).toBeNull();
  });

  it('配置了但没同意时，说清还差哪一步', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue({ ...configured, consent: false });
    draw();

    expect(await screen.findByText(/还没同意/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AI 讲解/ })).toBeNull();
  });

  it('点讲解显示 markdown、来源和「写成笔记」', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(configured);
    vi.spyOn(api, 'aiExplain').mockResolvedValue({
      markdown: '## 结论\n舌尖顶住上齿龈。',
      sources: [{ id: 'l-vs-n', title: 'l/n 混淆' }],
      provider: '接口·m',
    });
    draw();

    fireEvent.click(await screen.findByRole('button', { name: /AI 讲解/ }));

    expect(await screen.findByText(/舌尖顶住上齿龈/)).toBeTruthy();
    expect(screen.getByText('l/n 混淆')).toBeTruthy();
    expect(screen.getByRole('button', { name: /写成笔记/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /继续问助教/ }).getAttribute('href')).toContain('/assistant?word=click');
  });

  it('讲解失败时原样给出服务端的话', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(configured);
    vi.spyOn(api, 'aiExplain').mockRejectedValue(new Error('密钥被拒绝（401）'));
    draw();

    fireEvent.click(await screen.findByRole('button', { name: /AI 讲解/ }));
    expect(await screen.findByText(/密钥被拒绝/)).toBeTruthy();
  });

  it('写成笔记把草稿交给编辑器', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(configured);
    vi.spyOn(api, 'aiExplain').mockResolvedValue({
      markdown: '## 结论\n舌尖顶住。', sources: [], provider: '接口·m',
    });
    vi.spyOn(api, 'aiNoteDraft').mockResolvedValue({
      title: 'l 和 n',
      scope: 'phoneme',
      values: ['l', 'n'],
      contrasts: [],
      body: '## 自检法\n捏鼻。\n\n## 对比训练\n老 / 脑。',
      provider: '接口·m',
      sources: [],
    });
    draw();

    fireEvent.click(await screen.findByRole('button', { name: /AI 讲解/ }));
    fireEvent.click(await screen.findByRole('button', { name: /写成笔记/ }));

    expect(await screen.findByLabelText('标题')).toHaveProperty('value', 'l 和 n');
    expect(screen.getByLabelText('适用范围')).toHaveProperty('value', 'l, n');
  });

  it('词典里没有音标的词不给讲解按钮', async () => {
    vi.spyOn(api, 'aiStatus').mockResolvedValue(configured);
    draw(false);

    expect(await screen.findByText(/词典里没有这个词的音标/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /AI 讲解/ })).toBeNull();
  });
});
