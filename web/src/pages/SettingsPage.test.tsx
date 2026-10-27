import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STOP_HINT } from '../lib/brand';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Card } from 'antd';

/**
 * 渲染这一页要用的桩。
 *
 * 子组件一律换成一张同名卡：这一组要守的是**这一页的结构**（一次露几组、几张卡），
 * 而子组件自己的行为各有各的测试。换成同名卡之后，卡片清单就等于这一页真正的分组。
 */
vi.mock('../api', () => ({
  isOffline: () => false,
  api: {
    getMwKey: () => Promise.resolve({ configured: true, masked: '••••847f' }),
    runtime: () => Promise.resolve({ desktop: true, version: '1.0.0', appRoot: '/x', userNotes: '/y' }),
    setMwKey: () => Promise.resolve({ configured: true, masked: '••••847f' }),
    clearMwKey: () => Promise.resolve({ configured: false, masked: null }),
  },
}));
vi.mock('../components/CaptureSetting', () => ({ default: () => <Card title="录音采集" /> }));
vi.mock('../components/ModelSetting', () => ({ default: () => <Card title="备用评测模型" /> }));
vi.mock('../components/InkSetting', () => ({ default: () => <Card title="主题" /> }));
vi.mock('../components/BackupSetting', () => ({ default: () => <Card title="搬家" /> }));
vi.mock('../components/AiSettingsSection', () => ({ default: () => <Card title="选一个 AI 服务" /> }));

const { default: SettingsPage } = await import('./SettingsPage');

/**
 * 设置页引用别处的原话时，那句原话必须真的还在。
 *
 * ── 这个文件为什么存在 ──
 *
 * 设置页有一句「服务起来时会在窗口里打一行「…」」。上一版引的是
 * **「TO STOP: just close this window」**——那句英文在两次改动之后就没了：
 * 启动器改说中文（字搬进 scripts/msg/*.txt），停止提示挪进服务的启动输出
 * （改成中文的「要停下来：关掉这个窗口，或者按 Ctrl+C」）。
 * 全仓库一个字都不剩，而设置页还在原样引着它，**照着做的人会去窗口里找一句
 * 根本不会出现的话**。
 *
 * 类型检查看不见这种事（那只是个字符串字面量），测试也不会自己发现——
 * 是打开设置页一眼看到的。
 *
 * ── 为什么只能这么守 ──
 *
 * 这句话的原件在 `server/src/index.ts`，而 server 和 web 是两个独立的包，
 * 不引入共享包就传不过来——所以 web 这边**注定是一份拷贝**。拷贝没法消灭，
 * 那就让它对不上时会红：直接去读 index.ts 的源码比对。
 */
const root = join(import.meta.dirname, '..', '..', '..');

describe('设置页引的那句停止提示，服务必须真的会打', () => {
  it('web 端那份拷贝跟 server 的原件逐字一致', () => {
    const server = readFileSync(join(root, 'server', 'src', 'index.ts'), 'utf8');
    expect(
      server.includes(STOP_HINT),
      `server/src/index.ts 里没有这句话：「${STOP_HINT}」`,
    ).toBe(true);
  });

  it('服务确实会把它打出来，而不只是写在注释里', () => {
    const server = readFileSync(join(root, 'server', 'src', 'index.ts'), 'utf8');
    // 去掉注释再找一遍——只写在注释里等于没打
    const code = server
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // STOP_HINT 里有「Ctrl+C」——那个 + 在正则里是量词，直接拼进去会匹配不上。
    // 第一版就是这么写的，红了才发现是测试自己的错，不是代码的错。
    const lit = STOP_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(code).toMatch(new RegExp(`console\\.log\\(['"\`]${lit}`));
  });

  it('设置页用的是那个常量，不是自己又抄了一遍字面量', () => {
    const page = readFileSync(join(root, 'web', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
    expect(page).toMatch(/STOP_HINT/);
    // 正文里不许再出现一份手抄的（注释里解释历史的那句不算，它带着「TO STOP」的原文）
    const body = page.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(body.join('\n')).not.toContain(`「${STOP_HINT}」`);
  });

  /**
   * README 里也引了这句原话（「关掉它」那一节），那是**第三份拷贝**，
   * 而它跟前两份不一样：markdown 取不到常量，消灭不掉。
   *
   * 发布前核过一次，当时一字不差——但没有任何东西盯着它，下次改措辞就会悄悄对不上。
   * 而 README 是新用户唯一会读的文件，里面写着"窗口里会打这句话"，
   * 打的却是别的，人就会以为自己看错了或者版本不对。
   */
  it('README 引的那句停止提示，也得跟源件一字不差', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    // 前提：README 确实在讲这件事。哪天那一节整个删了，这条断言就该跟着撤，
    // 而不是让它空转——所以先断言"讲了"，再断言"讲对了"。
    expect(readme, 'README 里没有「关掉它」那一节了，这条守卫可以撤').toContain('## 关掉它');
    expect(readme, `README 引的停止提示跟 brand.ts 的 STOP_HINT 对不上：「${STOP_HINT}」`)
      .toContain(STOP_HINT);
  });
});

/**
 * 页头与启动/关闭两段（打磨稿 batch1 的 T-1 / T-2）。
 *
 * 一、H1 必须是页面名。原来屏上最大的字是「词典与评测」——那是六张卡里第一组
 *     的名字，而侧栏点的是「设置」、浏览器标签也是「设置 · 正音」，标签页和屏上
 *     打架。jsdom 之外没人拦得住"PageHead 的 title 填了组名"这种手滑，钉一下。
 * 二、开启/关闭两段说人话：「仓库」是 git 黑话（同一段前文自己用的是「正音这个
 *     文件夹」），而"开启"原来只写了 Windows 的桌面图标——macOS/Linux 用户照着
 *     找的是自己机器上不存在的操作路径。三个启动器本来都在，点名即可。
 */
describe('设置页的页头与启停文案', () => {
  const page = readFileSync(join(root, 'web', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
  // 只查 JSX 正文，注释里讲历史的那两句不算（它们正是在解释为什么不能那么写）
  const body = page.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  it('H1 是「设置」，跟侧栏导航项一字不差', () => {
    expect(body).toMatch(/<PageHead slug="设置" title="设置"/);
  });

  it('启停两段不出现「仓库」这种黑话', () => {
    expect(body, '又把停止文件说成"仓库里的"了').not.toContain('双击仓库里的');
    expect(body).toContain('双击正音文件夹里的 停止.cmd');
  });

  it('开启一段点名三个平台的启动器', () => {
    for (const f of ['启动.cmd', '启动.command', '启动.sh']) {
      expect(body, `启停文案漏了 ${f}`).toContain(f);
    }
  });

  it('AI 设置真的挂在这一页上，不只是建了个组件', () => {
    expect(body).toContain('<AiSettingsSection />');
  });

  it('已经注册过的人有直接拿 key 的地址，不用再走一遍注册流程', () => {
    expect(body).toContain('https://dictionaryapi.com/account/my-keys');
  });
});

it('桌面模式不说黑窗口，也不引浏览器那句停止提示', () => {
  const page = readFileSync(join(root, 'web', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
  expect(page).toContain('runtime?.desktop');
  const start = page.indexOf('const DESKTOP_HELP');
  expect(start, '桌面文案要收在 DESKTOP_HELP 这一个常量里').toBeGreaterThan(-1);
  const end = page.indexOf('// END DESKTOP_HELP');
  expect(end, '桌面文案后面要有 END DESKTOP_HELP 标记，守卫才知道切到哪').toBeGreaterThan(start);
  const block = page.slice(start + 'const DESKTOP_HELP'.length, end);
  expect(block).not.toContain('黑窗口');
  expect(block).not.toContain('STOP_HINT');
  expect(block).toMatch(/关.*窗口|退出/);
});

/**
 * 菜单栏撤了以后，原来挂在上面的动作改在设置页的「桌面版」一段里。
 *
 * 所以**指着那条菜单的文案必须跟着改掉**——留着「菜单「文件 → 打开数据文件夹」」
 * 这种话，读者会去找一条已经不存在的菜单，而那一段恰好是告诉他数据在哪的话。
 */
it('不再指着那条撤掉的菜单栏', () => {
  const page = readFileSync(join(root, 'web', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
  const start = page.indexOf('const DESKTOP_HELP');
  const end = page.indexOf('// END DESKTOP_HELP');
  expect(start).toBeGreaterThan(-1);
  const block = page.slice(start, end);
  expect(block, '桌面文案还在指那条菜单').not.toContain('菜单');
  expect(page, '设置页没挂上「桌面版」那一段').toContain('<DesktopPanel />');
});

it('README 也不再让人去找那条菜单', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  expect(readme, 'README 还在指那条菜单').not.toContain('文件 → 打开数据文件夹');
});

/**
 * 设置页**不是一页摊开**。
 *
 * 原来这一页是八张等权的卡竖着排，实测 3317px（2.7 屏）、56 个可聚焦控件、
 * 零分组——「设置界面过于复杂」说的就是这件事：不是哪张卡复杂，是八件事同时摊开，
 * 而且每一件看起来一样重，找不到自己那一件在哪。
 *
 * 现在按「你为什么来设置」分五组，一次只露一组。
 */
describe('设置页一次只露一组', () => {
  const cardTitles = (c: HTMLElement) =>
    [...c.querySelectorAll('.ant-card-head-title')].map((e) => e.textContent?.trim() ?? '');

  async function draw() {
    const r = render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => expect(r.container.querySelector('.ant-segmented')).toBeTruthy());
    return r.container;
  }

  it('有分组切换，而且整页最多三张卡', async () => {
    const c = await draw();
    expect(c.querySelectorAll('.ant-card').length, '一页还是摊开了好几组').toBeLessThanOrEqual(3);
  });

  it('五组都摆出来了，点哪组看哪组', async () => {
    const c = await draw();
    const items = [...c.querySelectorAll('.ant-segmented-item')];
    expect(items.length, '分组不是五组').toBe(5);
    const seen = new Set<string>();
    for (const item of items) {
      const input = item.querySelector('input');
      expect(input, '分组这一项不是 radio（键盘走不了）').toBeTruthy();
      fireEvent.click(input!);
      await waitFor(() => expect(c.querySelectorAll('.ant-card').length).toBeGreaterThan(0));
      seen.add(cardTitles(c).join('|'));
    }
    expect(seen.size, '五组里有两组内容一样（或者没切过去）').toBe(5);
  });

  it('每一组都说得清自己管什么', async () => {
    const c = await draw();
    const items = [...c.querySelectorAll('.ant-segmented-item')];
    for (const item of items) {
      fireEvent.click(item.querySelector('input')!);
      await waitFor(() => expect(c.querySelectorAll('.ant-card').length).toBeGreaterThan(0));
      // 组名下面那一句说明（次级字色那一行）
      const hint = [...c.querySelectorAll('.ant-typography-secondary')]
        .map((e) => e.textContent?.trim() ?? '')
        .filter((t) => t.length > 8 && !t.includes('key 只存在'));
      expect(hint.length, '这一组没有说明——只剩组名，读者不知道里面管什么').toBeGreaterThan(0);
    }
  });
});

/**
 * 「桌面版」那一段的位置。
 *
 * 它顶的是原来那条菜单栏，而菜单里「更换数据文件夹…」藏在**文件**子菜单的第三项——
 * 那种位置的特点是「其实有，但没人找得到」。菜单撤了以后，这一段如果还排在整页最底下
 * （词典/AI/录音/模型/纸墨/搬家之后），就等于把同一个毛病搬了个地方：
 * 刚问「数据文件夹目录怎么设置」的人，翻到最底下才找得到。
 *
 * 所以它必须紧跟在「怎么退出 / 数据在哪」那张卡后面——那是**整个应用里唯一**
 * 讲「数据在哪、怎么换」的卡，两个挨在一起才对得上。
 */
it('「桌面版」紧跟在「怎么退出 / 数据在哪」后面，不排在整页最底下', () => {
  const page = readFileSync(join(root, 'web', 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
  const panel = page.indexOf('<DesktopPanel />');
  const help = page.indexOf('怎么退出 / 数据在哪');
  const key = page.indexOf('<span>Merriam-Webster 词典 API key</span>');
  expect(panel, '设置页没挂「桌面版」那一段').toBeGreaterThan(-1);
  expect(help, '找不到「怎么退出 / 数据在哪」那张卡').toBeGreaterThan(-1);
  expect(panel, '「桌面版」没跟在那张卡后面').toBeGreaterThan(help);
  expect(panel, '「桌面版」被排到词典卡后面了，也就是整页最底下').toBeLessThan(key);
});
