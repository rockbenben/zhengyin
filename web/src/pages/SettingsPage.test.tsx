import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STOP_HINT } from '../lib/brand';

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
});
