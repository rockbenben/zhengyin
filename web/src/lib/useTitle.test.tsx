import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { useTitle } from './useTitle';
import { APP_NAME } from './brand';

function Probe({ t }: { t: string | null | undefined }) {
  useTitle(t);
  return null;
}

describe('每一页在标签页上叫什么', () => {
  it('有标题就挂上应用名', () => {
    render(<Probe t="thin" />);
    expect(document.title).toBe(`thin · ${APP_NAME}`);
  });

  it('还没读出来时只显示应用名，不摆一个空壳', () => {
    render(<Probe t={null} />);
    expect(document.title).toBe(APP_NAME);
    render(<Probe t={undefined} />);
    expect(document.title).toBe(APP_NAME);
    render(<Probe t="" />);
    expect(document.title).toBe(APP_NAME);
  });

  // 九个路由原来共用一个 `<title>`：正音。页面自己的 h1 各不相同，可标签页、
  // 浏览历史、收藏夹里全是同一个词——开两个标签分不清，收藏一个词条页也认不出来。
  // 漏掉一页不会有任何报错，只会又变回「正音」，所以让它会红。
  it('每个页面都得说出自己叫什么，一个都不能漏', () => {
    const dir = join(import.meta.dirname, '..', 'pages');
    const missing = readdirSync(dir)
      .filter((f) => f.endsWith('Page.tsx') && !f.includes('.test.'))
      .filter((f) => !/useTitle\(/.test(readFileSync(join(dir, f), 'utf8')));
    expect(missing, '这些页面没设标签页标题').toEqual([]);
  });
});

// placeholder 不是名字：一开始打字它就没了，读屏也未必拿它当名字。
// 这两个框一个是整个应用的主控件、一个是决定听真人还是合成音的那把钥匙。
//
// 首页那个在 HomePage.test.tsx 里直接量渲染出来的 DOM（那才是真凭据）。
// 设置页轻量渲染不了（要 Outlet context，还有四个子组件各自的接口），只能看源码——
// 但**得先把花括号表达式剥掉**：allowClear 的清空图标里也有个 aria-label，
// 整段一起 match 的话，把输入框自己那个删掉测试照样绿（变异测试里真活下来过）。
describe('输入框得说得出自己是什么', () => {
  it('设置页那个 API key 框有可访问名', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'pages', 'SettingsPage.tsx'), 'utf8');
    const el = src.match(/<Input\.Password[\s\S]*?\/>/)?.[0];
    expect(el, '没找到那个输入框').toBeTruthy();
    const own = el!.replace(/\{[\s\S]*?\}/g, '');   // 只留它自己的字面量属性
    expect(own, '只有 placeholder，没有可访问名').toMatch(/aria-label=|aria-labelledby=/);
  });
});
