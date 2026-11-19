import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AiSettingsSection from './AiSettingsSection';
import { api } from '../api';
import { clearAiDraft } from '../lib/aiDraft';
import { AI_PRESETS } from '../lib/aiPresets';
import { SHOW_PLANS_KEY } from '../lib/preferences';
import type { AiSettings, AiStatusInfo } from '../types';

const settingsOf = (over: Partial<AiSettings> = {}): AiSettings => ({
  schemaVersion: 1,
  consent: false,
  mode: 'api',
  endpointId: '',
  endpoints: {},
  cli: { kind: 'claude', path: '', customArgs: '', effort: '', model: '' },
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

async function chooseProvider(name: string, search?: string) {
  const provider = await screen.findByRole('combobox', { name: '服务商' });
  fireEvent.mouseDown(provider);
  if (search) fireEvent.change(provider, { target: { value: search } });
  fireEvent.click(await screen.findByRole('option', { name }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  // 草稿是模块级的（要跨卸载保留），所以每条用例都得从头开始——
  // 不清的话，上一条留下的草稿会漏进这一条，测的就不是这条用例了。
  clearAiDraft();
  localStorage.removeItem(SHOW_PLANS_KEY);
});

describe('AI 设置：接口模式', () => {
  it('默认是接口模式；点服务商填地址与模型', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf());
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    expect(await screen.findByText('调接口')).toBeTruthy();
    await chooseProvider('DeepSeek', 'deep');

    expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toBe('https://api.deepseek.com');
    expect(screen.getByText('DeepSeek Flash')).toBeTruthy();
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

    await chooseProvider('DeepSeek');
    fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'sk-test-1234' } });

    await chooseProvider('OpenAI');
    expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toContain('openai.com');

    await chooseProvider('DeepSeek');
    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('sk-test-1234');
    expect(screen.getByText('DeepSeek Flash')).toBeTruthy();
  });

  it('展开已预填模型的列表时可按 ID 搜索，手填值会随服务商保留', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    const model = await screen.findByRole('combobox', { name: '模型' });
    fireEvent.mouseDown(model);
    expect(await screen.findByRole('option', { name: /DeepSeek Flash.*默认/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /DeepSeek V4 Pro/ })).toBeTruthy();
    fireEvent.change(model, { target: { value: 'deepseek-v4-pro' } });
    expect(screen.queryByRole('option', { name: /DeepSeek Flash/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /DeepSeek V4 Pro/ }));

    fireEvent.click(screen.getByRole('button', { name: '手填 ID' }));
    const input = screen.getByRole('textbox', { name: '模型' });
    expect(input).toHaveProperty('value', 'deepseek-v4-pro');
    fireEvent.change(input, { target: { value: 'my-model' } });
    await chooseProvider('OpenAI');
    await chooseProvider('DeepSeek');
    expect(screen.getByText('my-model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '手填 ID' }));
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveProperty('value', 'my-model');
  });

  it('订阅套餐默认从选择器隐藏，开启高级选项后可以选择', async () => {
    const plan = AI_PRESETS.find((p) => p.hidden)!;
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf());
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    const provider = await screen.findByRole('combobox', { name: '服务商' });
    fireEvent.mouseDown(provider);
    expect(screen.queryByRole('option', { name: plan.label })).toBeNull();
    fireEvent.keyDown(provider, { key: 'Escape' });
    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.click(screen.getByRole('checkbox', { name: '显示订阅套餐接口' }));
    await chooseProvider(plan.label);
    expect(screen.getByRole('textbox', { name: '接口地址' })).toHaveProperty('value', plan.base);
  });

  it('上游移除的服务商仍可作为已保存的自定义接口选回', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'removed-provider',
      endpoints: {
        'removed-provider': { ...maskedDeepSeek, baseUrl: 'https://example.test/v1', model: 'legacy-model' },
      },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());
    render(<AiSettingsSection />);

    await chooseProvider('DeepSeek');
    await chooseProvider('自定义 · example.test', 'example.test');
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveProperty('value', 'legacy-model');
  });

  it('保存时把打码密钥原样带回，服务端才知道没动它', async () => {
    const save = vi.spyOn(api, 'saveAiSettings').mockImplementation(async (s) => s);
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf());

    render(<AiSettingsSection />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /我同意把发音档案/ }));
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

    await chooseProvider('自定义', '自定义');
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
      cli: { kind: 'codex', path: '', customArgs: '', effort: '', model: '' },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({
      mode: 'cli', configured: false, provider: 'codex', reason: '没找到 codex',
    }));
    render(<AiSettingsSection />);

    expect(await screen.findByText(/没找到 codex/)).toBeTruthy();
    expect(screen.getByLabelText('命令行路径')).toBeTruthy();
    expect(screen.queryByLabelText('接口地址')).toBeNull();
  });

  it('选 Antigravity 才给档位和模型：别的工具没有这两项', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      mode: 'cli',
      cli: { kind: 'agy', path: '', customArgs: '', effort: '', model: '' },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({ mode: 'cli', configured: true, provider: 'agy' }));
    render(<AiSettingsSection />);

    expect(await screen.findByLabelText('推理档位')).toBeTruthy();
    expect(screen.getByLabelText('命令行模型')).toBeTruthy();
    expect(screen.getByText(/默认拿的是带思考的档/)).toBeTruthy();
  });

  it('档位和模型会跟着保存走', async () => {
    const save = vi.spyOn(api, 'saveAiSettings').mockImplementation(async (s) => s);
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      consent: true,
      mode: 'cli',
      cli: { kind: 'agy', path: '', customArgs: '', effort: '', model: '' },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({ mode: 'cli', configured: true, provider: 'agy' }));

    render(<AiSettingsSection />);
    const model = await screen.findByLabelText('命令行模型');
    fireEvent.change(model, { target: { value: 'gpt-oss-120b-medium' } });
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].cli.model).toBe('gpt-oss-120b-medium');
  });

  it('命令行模式下说清测试连接用最轻的配置', async () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      mode: 'cli',
      cli: { kind: 'agy', path: '', customArgs: '', effort: '', model: '' },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({ mode: 'cli', configured: true, provider: 'agy' }));
    render(<AiSettingsSection />);

    expect(await screen.findByText(/用最轻的配置跑一句/)).toBeTruthy();
  });
});

/**
 * 切组不丢没保存的输入。
 *
 * 设置页按五组切换，「AI 讲解」那一张卡切走再切回来会**重新挂载**——
 * 而草稿本来只活在组件的 useState 里，于是刚输入的密钥、刚勾的同意跟着卸载一起消失，
 * 用户得从头再打一遍（密钥那么长）。
 */
describe('切组不丢草稿', () => {
  const withDeepSeek = () => {
    vi.spyOn(api, 'aiSettings').mockResolvedValue(settingsOf({
      endpointId: 'deepseek',
      endpoints: { deepseek: maskedDeepSeek },
    }));
    vi.spyOn(api, 'aiStatus').mockResolvedValue(statusOf({
      configured: true, provider: 'openai·deepseek-flash',
    }));
  };

  it('重新挂载之后，刚输入的密钥和刚勾的同意还在', async () => {
    withDeepSeek();
    const first = render(<AiSettingsSection />);
    fireEvent.change(await screen.findByLabelText('密钥'), { target: { value: 'sk-new-value' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /我同意把发音档案/ }));
    first.unmount();

    render(<AiSettingsSection />);
    expect((await screen.findByLabelText('密钥') as HTMLInputElement).value).toBe('sk-new-value');
    expect(screen.getByRole('checkbox', { name: /我同意把发音档案/ })).toHaveProperty('checked', true);
  });

  it('保存过之后草稿作废——重新进来是服务端那份，不是旧草稿', async () => {
    withDeepSeek();
    const save = vi.spyOn(api, 'saveAiSettings').mockImplementation(async (s) => s);
    const first = render(<AiSettingsSection />);
    fireEvent.change(await screen.findByLabelText('密钥'), { target: { value: 'sk-new-value' } });
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    first.unmount();

    render(<AiSettingsSection />);
    expect((await screen.findByLabelText('密钥') as HTMLInputElement).value).toBe(maskedDeepSeek.key);
  });
});
