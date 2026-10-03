import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UserSwitcher } from './UserSwitcher';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    user: vi.fn(),
    switchUser: vi.fn(),
    createUser: vi.fn(),
  },
}));

// message 是静态导入（跟 BackupSetting.tsx 等现有组件同一种写法），要拦下它
// 弹的内容就得像 StarButton.test.tsx 那样局部替换 antd 的 message，其余照旧走真实现。
const stub = vi.hoisted(() => ({ toast: [] as string[] }));
vi.mock('antd', async () => {
  const real = await vi.importActual<typeof import('antd')>('antd');
  return { ...real, message: { ...real.message, error: (m: string) => stub.toast.push(m) } };
});

const mocked = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  stub.toast = [];
  mocked.user.mockResolvedValue({ current: '默认', users: ['默认', '张三'] });
});

describe('UserSwitcher', () => {
  it('显示当前用户名', async () => {
    render(<UserSwitcher />);
    expect(await screen.findByText(/默认/)).toBeTruthy();
  });

  it('服务连不上时整个不渲染，不摆死控件', async () => {
    mocked.user.mockRejectedValue(new Error('offline'));
    const { container } = render(<UserSwitcher />);
    await waitFor(() => expect(mocked.user).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('点另一个用户 → 调 switchUser 并刷新', async () => {
    mocked.switchUser.mockResolvedValue({ current: '张三', users: ['默认', '张三'] });
    const reload = vi.fn();
    render(<UserSwitcher reload={reload} />);
    fireEvent.click(await screen.findByText(/默认/));          // 打开下拉
    fireEvent.click(await screen.findByText('张三'));
    await waitFor(() => expect(mocked.switchUser).toHaveBeenCalledWith('张三'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('添加用户：createUser 后自动切过去', async () => {
    mocked.createUser.mockResolvedValue({ current: '默认', users: ['默认', '张三', '李四'] });
    mocked.switchUser.mockResolvedValue({ current: '李四', users: ['默认', '张三', '李四'] });
    const reload = vi.fn();
    render(<UserSwitcher reload={reload} />);
    fireEvent.click(await screen.findByText(/默认/));
    fireEvent.click(await screen.findByText(/添加用户/));
    fireEvent.change(await screen.findByPlaceholderText(/名字/), { target: { value: '李四' } });
    fireEvent.click(screen.getByText((t) => t.replace(/\s/g, '').includes('建好并切过去')));
    await waitFor(() => expect(mocked.createUser).toHaveBeenCalledWith('李四'));
    await waitFor(() => expect(mocked.switchUser).toHaveBeenCalledWith('李四'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  // 这里 mock 的是整个 `../api` 模块，测不到 api.ts 里 jx 还是 j 那个选择——
  // 那件事由 api.test.tsx 的「切人 / 建人失败时，弹出来的是服务端中文」两条
  // 顶着 fetch 去测。这条测的是组件自己这一层：不管 api.switchUser 抛出的
  // Error.message 是什么，catch 必须原样把它交给 message.error，不能自己
  // 再套一层别的文案、也不能把它吞掉。
  it('switchUser 失败 → catch 把 e.message 原样交给 message.error', async () => {
    mocked.switchUser.mockRejectedValue(new Error('没有叫「张三」的用户'));
    render(<UserSwitcher />);
    fireEvent.click(await screen.findByText(/默认/));
    fireEvent.click(await screen.findByText('张三'));
    await waitFor(() => expect(stub.toast.length).toBe(1));
    expect(stub.toast[0]).toBe('没有叫「张三」的用户');
  });
it('添加用户弹窗的输入框算得出名字——placeholder 不是名字', async () => {
    // 本仓库自己的判据（HomePage 的 aria-label 注释）：一开始打字 placeholder 就没了，
    // 读屏也未必拿它当名字。首页主框守了，弹窗曾经漏了（探针实测可及名=空串）。
    render(<UserSwitcher />);
    fireEvent.click(await screen.findByText(/默认/));
    fireEvent.click(await screen.findByText('添加用户…'));
    expect(await screen.findByRole('textbox', { name: '新用户名字' })).toBeTruthy();
  });

});