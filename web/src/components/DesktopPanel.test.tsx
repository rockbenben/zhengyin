import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DesktopPanel from './DesktopPanel';
import type { DesktopBridge, DesktopState } from '../lib/desktop';

function fakeBridge(over: Partial<DesktopState> = {}): DesktopBridge {
  return {
    state: vi.fn(async () => ({
      version: '1.0.0',
      updater: true,
      devTools: false,
      autoCheck: false,
      updateReady: null,
      ...over,
    })),
    openDataFolder: vi.fn(async () => {}),
    changeDataFolder: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    about: vi.fn(async () => {}),
    checkUpdate: vi.fn(async () => {}),
    setAutoCheck: vi.fn(async () => {}),
    restartToUpdate: vi.fn(async () => {}),
    devTools: vi.fn(async () => {}),
  };
}

let bridge: DesktopBridge;

/** 装一个桥。**返回的就是装上去的那一个**——不然断言会打在另一个 mock 上。 */
function mount(over: Partial<DesktopState> = {}): DesktopBridge {
  bridge = fakeBridge(over);
  window.zhengyinDesktop = bridge;
  return bridge;
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  delete window.zhengyinDesktop;
});

/**
 * 这一段顶的是那条撤掉的菜单栏。
 *
 * 所以断言的是**菜单里有的动作一个都不能少**——少一个就是悄悄少给了功能，
 * 而「按钮在不在」正是这类改动最容易漏的地方：类型对、编译过、点了没反应。
 *
 * 按钮名用正则而不是原样：antd 会在**两个汉字**之间插一个空格（「退出」渲染成
 * 「退 出」），写死字符串会一个都找不到——那种红是测试自己的错，不是界面的错。
 */
describe('菜单栏撤了以后，它的动作改在这一段里', () => {
  it('浏览器模式里这一段什么都不渲染——摆一组点不动的按钮比不摆更糟', () => {
    delete window.zhengyinDesktop;
    const { container } = render(<DesktopPanel />);
    expect(container.textContent).toBe('');
  });

  it('菜单里有的动作一个都不能少', async () => {
    render(<DesktopPanel />);
    for (const name of [/打开数据文件夹/, /更换数据文件夹/, /重新加载/, /关于正音/, /退\s*出/]) {
      expect(await screen.findByRole('button', { name }), `少了「${name}」`).toBeTruthy();
    }
    expect(await screen.findByRole('button', { name: /检查更新/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /自动检查更新/ })).toBeTruthy();
  });

  it('点一下真的调到了主进程', async () => {
    render(<DesktopPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /打开数据文件夹/ }));
    expect(bridge.openDataFolder).toHaveBeenCalled();
  });

  it('开发模式才有开发者工具', async () => {
    render(<DesktopPanel />);
    await screen.findByRole('button', { name: /退\s*出/ });
    expect(screen.queryByRole('button', { name: /开发者工具/ })).toBeNull();
  });
});

describe('更新那几项按打包形态摆', () => {
  it('zip 免安装版没有更新器 → 不摆「检查更新」', async () => {
    mount({ updater: false });
    render(<DesktopPanel />);
    await screen.findByRole('button', { name: /退\s*出/ });
    expect(screen.queryByRole('button', { name: /检查更新/ })).toBeNull();
  });

  it('下好的更新要摆出「重启以完成更新」，点它调的是主进程', async () => {
    const b = mount({ updateReady: '1.2.0' });
    render(<DesktopPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /重启以完成更新/ }));
    expect(b.restartToUpdate).toHaveBeenCalled();
  });

  it('自动检查更新的勾能拨动', async () => {
    render(<DesktopPanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /自动检查更新/ }));
    expect(bridge.setAutoCheck).toHaveBeenCalledWith(true);
  });
});
