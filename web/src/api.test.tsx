import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, isOffline } from './api';

/**
 * 「连不上服务」和「服务说没有」必须在这一层就分开。
 *
 * 分不开的后果实测过：把服务关掉之后，每个词条页都说「库里还没有这个词」，
 * 还请你回首页去建——而首页同样连不上。一个本地工具最常见的故障
 * （启动的那个窗口被关掉了），界面给的是一条走不通的路。
 *
 * 页面那一侧的用例（WordPage.test.tsx）把 isOffline 打成了桩，**测不到这里**——
 * 变异测试里"把标签去掉"那一条就是从那儿溜过去的。所以这一节直接打 fetch。
 */

afterEach(() => vi.unstubAllGlobals());

describe('连不上 vs 服务说没有', () => {
  it('fetch 抛错（服务没起）→ 标成 offline', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const e = await api.getEntry('coffee').catch((x: unknown) => x);
    expect(isOffline(e), '服务连不上，却没被标成 offline').toBe(true);
  });

  it('HTTP 404（服务在跑，就是没这个词）→ 不是 offline', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 404 })));
    const e = await api.getEntry('coffee').catch((x: unknown) => x);
    expect(isOffline(e), '真 404 被当成了连不上').toBe(false);
    expect((e as Error).message).toContain('404');
  });

  it('HTTP 500 也不是 offline——服务在跑，只是这次崩了', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 500 })));
    const e = await api.getEntry('coffee').catch((x: unknown) => x);
    expect(isOffline(e)).toBe(false);
  });

  it('带服务端文案的那条路（jx）也要标', async () => {
    // 设置页存 key 走 jx。它跟 j 是两个函数，漏一个就有半边界面还在说错话
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const e = await api.setMwKey('x').catch((x: unknown) => x);
    expect(isOffline(e), 'jx 那条路没标 offline').toBe(true);
  });

  it('isOffline 不会把普通错误误判成连不上', () => {
    expect(isOffline(new Error('API 404'))).toBe(false);
    expect(isOffline(null)).toBe(false);
    expect(isOffline('连不上')).toBe(false);
    expect(isOffline({ offline: 'true' }), '只认布尔 true，字符串不算').toBe(false);
  });
});
