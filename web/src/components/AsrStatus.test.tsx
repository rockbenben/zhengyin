import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AsrStatus from './AsrStatus';
import { api } from '../api';

// Vosk 备用模型在 jsdom 里探测不出结果；这里只关心边车状态，把它固定成可用。
vi.mock('../lib/asr', () => ({
  checkModelAvailability: vi.fn(async () => 'available'),
}));

beforeEach(() => vi.restoreAllMocks());

it('starting：摊开日志、给重启按钮，不说“看黑窗口”', async () => {
  vi.spyOn(api, 'asrStatus').mockResolvedValue({
    state: 'starting', port: 30123, uvFound: true, startedAt: Date.now(),
    error: null, log: ['模型不在本地缓存里，开始获取', 'Downloading 12%'],
  });
  render(<AsrStatus pollMs={10_000} />);
  expect(await screen.findByText(/正在启动|加载模型/)).toBeTruthy();
  expect(screen.getByText(/Downloading 12%/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /重启/ })).toBeTruthy();
  expect(document.body.textContent).not.toContain('黑窗口');
});

it('error：原样给出错误与日志', async () => {
  vi.spyOn(api, 'asrStatus').mockResolvedValue({
    state: 'error', port: null, uvFound: true, startedAt: null,
    error: '识别服务退出了（退出码 1）', log: ['ModuleNotFoundError: torch'],
  });
  render(<AsrStatus pollMs={10_000} />);
  expect(await screen.findByText(/退出码 1/)).toBeTruthy();
  expect(screen.getByText(/ModuleNotFoundError/)).toBeTruthy();
});

it('ready：安静，不占版面', async () => {
  vi.spyOn(api, 'asrStatus').mockResolvedValue({
    state: 'ready', port: 30123, uvFound: true, startedAt: 1, error: null, log: [],
  });
  const { container } = render(<AsrStatus pollMs={10_000} />);
  await waitFor(() => expect(api.asrStatus).toHaveBeenCalled());
  await waitFor(() => expect(container.textContent).toBe(''));
  expect(screen.queryByRole('button', { name: /重启/ })).toBeNull();
});
