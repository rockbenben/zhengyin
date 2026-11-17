import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DesktopPanel from './DesktopPanel';
import type { DesktopBridge, DesktopState, UpdateState } from '../lib/desktop';

function fakeBridge(over: Partial<DesktopState> = {}): DesktopBridge {
  return {
    state: vi.fn(async () => ({
      version: '1.0.0',
      updater: true,
      devTools: false,
      autoCheck: false,
      updateReady: null,
      updateState: 'idle' as UpdateState,
      ...over,
    })),
    preferences: vi.fn(async () => ({})),
    setPreference: vi.fn(async () => {}),
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

/**
 * 「检查更新」点了之后必须有回音。
 *
 * 之前点完界面上一动不动：没有新版时更新器只是回到 idle，而那个状态没人读——
 * 用户分不清「没反应」和「没有新版」。现在主进程把更新状态透出来，
 * 查完回到 idle 就说一声「已经是最新版本了」。
 */
describe('检查更新要有回音', () => {
  it('正在检查时按钮是 loading', async () => {
    mount({ updateState: 'checking' });
    render(<DesktopPanel />);
    const btn = await screen.findByRole('button', { name: /检查更新/ });
    expect(btn.className).toMatch(/ant-btn-loading/);
  });

  it('查完没有新版 → 说一声「已经是最新版本了」', async () => {
    mount({ updateState: 'checking' });
    render(<DesktopPanel />);
    await screen.findByRole('button', { name: /检查更新/ });
    // 主进程那边状态从「正在检查」回到「空闲」了
    (bridge.state as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: '1.0.0', updater: true, devTools: false, autoCheck: false,
      updateReady: null, updateState: 'idle',
    });
    await waitFor(() => expect(screen.getByText('已经是最新版本了')).toBeTruthy(), { timeout: 4000 });
  });

  it('读不到状态要说出来，不能把整块更新区悄悄收走', async () => {
    mount();
    (bridge.state as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('通道没注册'));
    render(<DesktopPanel />);
    expect(await screen.findByText('读不到桌面外壳的状态')).toBeTruthy();
  });
});

/**
 * 面板摆出来的按钮，就是正本（`desktop/src/bridge.ts`）里那三张清单。
 *
 * 那三张清单原来**只有测试读**，生产代码一处都不看——于是在四处都加好了、
 * 唯独忘了在面板上加按钮，所有测试照样全绿。清单要当正本用，就得有人盯着
 * 「面板上摆的」和「清单里列的」是不是同一批。
 */
describe('面板上的动作 = 正本里那三张清单', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const desktopSrc = readFileSync(join(root, 'desktop', 'src', 'bridge.ts'), 'utf8');

  /** 从正本里读一张清单（动作名） */
  const listOf = (name: string): string[] => {
    const block = desktopSrc.slice(desktopSrc.indexOf(`export const ${name}`));
    return [...block.slice(0, block.indexOf('] as const')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };

  /** 动作名 → 界面上那个控件的字 */
  const TEXT: Record<string, string> = {
    openDataFolder: '打开数据文件夹',
    changeDataFolder: '更换数据文件夹…',
    reload: '重新加载',
    quit: '退出',
    about: '关于正音',
    checkUpdate: '检查更新',
    setAutoCheck: '自动检查更新',
    restartToUpdate: '重启以完成更新',
    devTools: '开发者工具',
  };

  it('正本里有的，面板上都得有；面板上多出来的也没有', async () => {
    const actions = [...listOf('USER_ACTIONS'), ...listOf('UPDATER_ACTIONS'), ...listOf('DEV_ACTIONS')];
    mount({ updater: true, devTools: true, updateReady: '1.2.0' });
    render(<DesktopPanel />);
    await screen.findByRole('button', { name: /检查更新/ });

    // antd 会在两个汉字之间插一个空格（"退出"渲染成"退 出"），所以比对前去掉空白。
    // 勾选框的字在 <label> 上，不在那个 <input> 里——所以从 label 上取。
    const shown = [
      ...screen.getAllByRole('button').map((el) => el.textContent ?? ''),
      ...screen.getAllByRole('checkbox').map((el) => el.closest('label')?.textContent ?? ''),
    ].map((t) => t.replace(/\s+/g, ''));

    for (const a of actions) {
      expect(shown, `正本里有「${a}」，面板上却没有`).toContain(TEXT[a]);
    }
    const allowed = actions.map((a) => TEXT[a]);
    for (const s of shown) {
      expect(allowed, `面板上多了一个清单之外的动作：${s}`).toContain(s);
    }
  });
});
