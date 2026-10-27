import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AiSettingsSection from './AiSettingsSection';
import { api } from '../api';
import type { AiSettings, AiStatusInfo } from '../types';

const settingsOf = (over: Partial<AiSettings> = {}): AiSettings => ({
  schemaVersion: 1,
  consent: false,
  mode: 'api',
  endpointId: '',
  endpoints: {},
  cli: { kind: 'claude', path: '', customArgs: '' },
  ...over,
});

const statusOf = (over: Partial<AiStatusInfo> = {}): AiStatusInfo => ({
  configured: false, mode: 'api', consent: false, provider: null, reason: '还没选接口', ...over,
});

const maskedDeepSeek = {
  protocol: 'openai' as const,
  baseUrl: 'https://api.deepseek.com',
  key: '••••5678',
  model: 'deepseek-flash',
};

beforeEach(() => vi.restoreAllMocks());

describe('AI 设置：接口模式', () => {
  it('默认是接口模式；点服务商填地址与模型', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf());
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    expect(await screen.findByText('调接口')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'DeepSeek' }));

    expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toBe('https://api.deepseek.com');
    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('deepseek-flash');
  });

  it('已保存的密钥只显示打码', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({ configured: true, provider: 'openai·deepseek-flash' }));
    render(<AiSettingsSection />);

    expect(await screen.findByLabelText('密钥')).toHaveProperty('value', '••••5678');
  });

  it('切走再切回来，各家自己的地址、模型和密钥都还在', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf());
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'DeepSeek' }));
    fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'sk-test-1234' } });

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toContain('openai.com');

    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('sk-test-1234');
    expect((screen.getByLabelText('模型') as HTMLInputElement).value).toBe('deepseek-flash');
  });

  it('保存时把打码密钥原样带回，服务端才知道没动它', async () => {
    const save = vi.spyOn(api, 'saveAiSettings').mockImplementation(async (s) => s);
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());

    render(<AiSettingsSection />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    const sent = save.mock.calls[0][0];
    expect(sent.consent).toBe(true);
    expect(sent.endpointId).toBe('deepseek');
    expect(sent.endpoints.deepseek).toEqual(maskedDeepSeek);
  });

  it('未勾选同意时测试连接不发请求', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    const test = vi.spyOn(api, 'aiTest');
    const save = vi.spyOn(api, 'saveAiSettings');

    render(<AiSettingsSection />);
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }));

    expect(await screen.findByText(/先勾选/)).toBeTruthy();
    expect(test).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('勾选后测试连接显示耗时与回复', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      consent: true,
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({ consent: true, configured: true, provider: 'openai·m' }));
    vi.spyOn(api, 'saveAiSettings').mockImplementation(async (s) => s);
    vi.spyOn(api, 'aiTest').mockResolvedValue({ ok: true, latencyMs: 42, sample: 'OK', provider: '接口·m' });

    render(<AiSettingsSection />);
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }));

    const ok = await screen.findByText(/连接成功/);
    expect(ok.textContent).toContain('42');
    expect(ok.textContent).toContain('接口·m');
  });

  it('自定义端点要求自己选协议', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf());
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    fireEvent.click(await screen.findByRole('button', { name: '自定义' }));
    expect(screen.getByText('协议')).toBeTruthy();
    expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toBe('');
  });

  it('切了模式还没保存时，说清状态还是旧的那一套', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf());
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    fireEvent.click(await screen.findByRole('radio', { name: /用本机命令行/ }));
    expect(screen.getByText(/按「保存」之后才生效/)).toBeTruthy();
  });
});

describe('AI 设置：命令行模式', () => {
  it('选命令行后给出工具、路径和状态，不再显示接口地址', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      mode: 'cli',
      cli: { kind: 'codex', path: '', customArgs: '' },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({
      mode: 'cli', configured: false, provider: 'codex', reason: '没找到 codex',
    }));
    render(<AiSettingsSection />);

    expect(await screen.findByText(/没找到 codex/)).toBeTruthy();
    expect(screen.getByLabelText('命令行路径')).toBeTruthy();
    expect(screen.queryByLabelText('接口地址')).toBeNull();
  });
});
