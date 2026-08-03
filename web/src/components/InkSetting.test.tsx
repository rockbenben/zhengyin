import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router';
import { useState } from 'react';
import InkSetting from './InkSetting';
import {
  DEFAULT_HUE, PRESETS, inkFor, isDarkPaper, loadHue, loadPaper,
  savePaper, saveHue, type PaperPref,
} from '../lib/ink';
import type { InkContext } from '../layout';

/**
 * 换墨这一块，以及墨色的存取。
 *
 * 存取放这里而不是 lib/ink.test.ts：那个文件跑在 node 档
 * （vitest.config.ts 把 web/src/lib 归到那边），没有 localStorage。
 *
 * 守的两件事都是"接线接没接上"那一类——类型检查看不出"声明了但没用"：
 *   一、点一款墨，**画面上真的换了颜色**（不是只把状态改了）
 *   二、换过的墨**存得住**，刷新回来还是它
 */

/** 拿一个真的有 hue 状态的壳子把 InkSetting 套起来，模拟 layout 那一层 */
function Harness({ systemDark }: { systemDark: boolean }) {
  const [hue, setHue] = useState(loadHue);
  const [paper, setPaper] = useState<PaperPref>(loadPaper);
  const ctx: InkContext = {
    hue, setHue: (h) => { setHue(h); saveHue(h); },
    paper, setPaper: (p) => { setPaper(p); savePaper(p); },
    dark: isDarkPaper(paper, systemDark),
  };
  return <Outlet context={ctx} />;
}

function draw(systemDark = false) {
  const { container } = render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route element={<Harness systemDark={systemDark} />}>
          <Route path="/settings" element={<InkSetting />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return container;
}

/** 页面上出现过的所有背景色，用来判断"画面真的换了" */
const inksOnScreen = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>('span[style*="background"]')].map((e) => e.style.background);

const swatch = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes(name))!;

/**
 * ── 纸的开关 ──
 *
 * 补它是因为使用者当场问「浅色纸是浅色主题吗，怎么没地方切换」——
 * 卡里摆着两块标着「浅色纸/深色纸」的样张，看着像能挑，而原来确实不能。
 */
describe('纸', () => {
  beforeEach(() => localStorage.clear());

  it('三档都给：跟随系统 / 浅色 / 深色', () => {
    const text = draw().textContent ?? '';
    for (const s of ['跟随系统', '浅色纸', '深色纸']) expect(text, s + ' 没出现').toContain(s);
  });

  it('默认跟随系统，不是钉死某一套', () => {
    expect(swatch(draw(), '跟随系统').getAttribute('aria-pressed')).toBe('true');
  });

  it('挑了深色纸，画面真的换成深色纸的墨', () => {
    const c = draw(false);            // 系统是浅色
    const before = swatch(c, '群青').querySelector<HTMLElement>('span')!.style.background;
    fireEvent.click(swatch(c, '深色纸'));
    const after = swatch(c, '群青').querySelector<HTMLElement>('span')!.style.background;
    expect(after, '点了深色纸，色块还是浅色纸那一版').not.toBe(before);
  });

  it('挑过的纸存得住', () => {
    fireEvent.click(swatch(draw(), '深色纸'));
    expect(loadPaper()).toBe('dark');
  });

  it('跟随系统这一档要说清现在实际是哪套——否则看不出它到底选中了什么', () => {
    expect(draw(true).textContent, '系统深色时没说现在是深色').toMatch(/现在是深色/);
    expect(draw(false).textContent).toMatch(/现在是浅色/);
  });

  it('两块样张要标出哪一块是你正看着的', () => {
    // 并排两块却不说，人会以为两套都在用
    expect(draw().textContent).toContain('当前');
  });

  it('存进去的纸不是这三档之一 → 回跟随系统', () => {
    localStorage.setItem('overprint.paper', '"sepia"');
    expect(loadPaper()).toBe('system');
  });
});

describe('换墨', () => {
  beforeEach(() => localStorage.clear());

  it('每一款备好的墨都摆出来，点得到', () => {
    const c = draw();
    for (const p of PRESETS) expect(swatch(c, p.name), `${p.name} 没出现`).toBeDefined();
  });

  it('色块按当前这套纸画——不然给的是屏幕上根本不存在的颜色', () => {
    // 实测截图发现的：深色纸上，色块画的是浅色纸的墨，
    // 铜绿那块成了近乎黑的 #005a40，而它在深色纸上其实是浅绿 #60bc97。
    const inLight = swatch(draw(false), '铜绿').querySelector<HTMLElement>('span')!.style.background;
    const inDark = swatch(draw(true), '铜绿').querySelector<HTMLElement>('span')!.style.background;
    expect(inDark, '两套纸上色块画得一样，说明没跟着纸走').not.toBe(inLight);
  });

  it('预览的两格各自说清是哪一种，而且用评测里的说法', () => {
    // 左边那格没有边框、只有一个孤零零的黑字，不配字看着像排版漏了，
    // 而它恰恰是"两版重合了就只剩一个字"这件事本身。
    //
    // **不许用印刷术语。** 原来写的是「套准 / 滑开」，而 OverprintStrip 顶上
    // 那条约束点名的就是这两个词：留在注释里解释设计意图可以，跑到界面上当术语不行，
    // 第一版这么写没人看得懂。真正的套印带上写的是「重合就是发对了」。
    const text = draw().textContent ?? '';
    expect(text, '没说清哪一格是发对了').toMatch(/重合/);
    expect(text, '没说清哪一格是发错了').toMatch(/错开|不重合/);
    expect(text, '印刷术语跑到界面上了').not.toMatch(/套准|滑开/);
  });

  it('说清楚为什么屉里没有暖色——不说的话四款冷色看着像随便挑的', () => {
    const text = draw().textContent ?? '';
    expect(text).toMatch(/暖色|冷色/);
    expect(text, '没点出是跟哪两个信号撞').toMatch(/提醒/);
  });

  it('点一款墨，画面上真的换了颜色', () => {
    const c = draw();
    const before = inksOnScreen(c);
    fireEvent.click(swatch(c, '铜绿'));
    const after = inksOnScreen(c);
    expect(after, '点了没反应——状态和画面没接上').not.toEqual(before);
  });

  it('换过的墨存得住，重新打开还是它', () => {
    fireEvent.click(swatch(draw(), '铜绿'));
    expect(loadHue()).toBe(PRESETS.find((p) => p.name === '铜绿')!.hue);
  });

  it('选中的那一款要看得出是选中的', () => {
    const c = draw();
    fireEvent.click(swatch(c, '紫'));
    expect(swatch(c, '紫').getAttribute('aria-pressed')).toBe('true');
    expect(swatch(c, '铜绿').getAttribute('aria-pressed')).toBe('false');
  });

  it('深浅两套纸都预览——换墨的人多半只看得到自己那套', () => {
    const c = draw();
    expect(c.textContent).toContain('浅色纸');
    expect(c.textContent).toContain('深色纸');
    // 而且两套里出现的墨色确实不一样（同一个色相，两套纸上各自调过）
    const light = inkFor(DEFAULT_HUE, false).ink;
    const dark = inkFor(DEFAULT_HUE, true).ink;
    expect(light).not.toBe(dark);
  });

  it('说清楚墨色只存在本机', () => {
    // 换台电脑要重挑，不说的话人会以为跟着账号走
    expect(draw().textContent).toMatch(/浏览器|本机|localStorage/);
  });
});

describe('墨色的存取', () => {
  beforeEach(() => localStorage.clear());

  it('存了就读得回来', () => {
    const 紫 = PRESETS.find((p) => p.name === '紫')!.hue;
    saveHue(紫);
    expect(loadHue()).toBe(紫);
  });

  it('没存过 → 默认群青', () => {
    expect(loadHue()).toBe(DEFAULT_HUE);
  });

  it('存进去的是坏值 → 回默认，不要让界面变成一团糟', () => {
    localStorage.setItem('overprint.hue', '{{{坏了');
    expect(loadHue()).toBe(DEFAULT_HUE);
  });

  it('存的那款墨已经不在屉里了 → 回默认，不留一个改不掉的状态', () => {
    // 删掉赭石（60°）那次真会发生：挑过它的人升级后存着的还是 60，
    // 而界面上没有哪一款是选中的——既看不见又改不掉。
    localStorage.setItem('overprint.hue', '60');
    expect(loadHue()).toBe(DEFAULT_HUE);
  });

  it('存进去一个不是墨屉里的数（负数、别的角度）→ 回默认', () => {
    // 归一化那一步已经从 loadHue 里删了：「必须在屉里」把它整个吞掉，
    // 而且没有任何路径会存出 -30 这种值。
    saveHue(-30);
    expect(loadHue()).toBe(DEFAULT_HUE);
  });

  it('localStorage 用不了时不许抛错——换个墨色而已，不该弄崩页面', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => saveHue(200)).not.toThrow();
    spy.mockRestore();
  });
});
