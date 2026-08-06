import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME, APP_TAGLINE, REPO_URL } from './brand';

/**
 * 名字只能有一个。
 *
 * 这个仓库一度有**四个**名字：磁盘目录 `031-pronunciation`、包名 `zhengyin`、
 * 界面上的「发音诊室」、README 标题的「发音笔记」——仓库叫正音，
 * 而这个名字一处都没体现。
 *
 * 麻烦在于它必须出现在两个 React 管不着的地方——浏览器标签页（静态 index.html）
 * 和 package.json。改一处忘了别处不会有任何报错，只会又攒出第五个名字。
 * 所以这里把它们钉在一起。
 *
 * **不锁具体叫什么**（这个仓库的规矩是不锁文案），锁的是"处处一致"。
 * 真要改名，改 brand.ts 一处，这些用例会告诉你还有哪几个文件没跟上。
 */

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('这个工具只有一个名字', () => {
  it('浏览器标签页跟刊头同名', () => {
    const html = read('web/index.html');
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    expect(title, 'index.html 没有 <title>').toBeTruthy();
    expect(title).toBe(APP_NAME);
  });

  it('手机上加到主屏幕的名字也一样', () => {
    const html = read('web/index.html');
    expect(html).toContain(`content="${APP_NAME}"`);
  });

  it('包名是这个名字的拼音——不然 npm 和界面各叫各的', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string };
    expect(pkg.name).toBe('zhengyin');
  });

  it('README 的标题也是它', () => {
    expect(read('README.md').split('\n')[0].trim()).toBe(`# ${APP_NAME}`);
  });

  /**
   * 旧名字在用户看得见的地方一处不剩。
   *
   * ── 为什么是**扫**，不是列一张表 ──
   *
   * 这一条原来是一张手写的文件清单，上面有 `启动.sh` 和 `停止.sh`，
   * 却没有 `启动.command`、`停止.command`，也没有 manifest.webmanifest。
   * 于是那三个文件里的「发音诊室」一直活着——**守着这件事的测试自己漏了它们**：
   * macOS 用户双击启动，窗口上打的是旧名；把网页装到主屏幕，图标下面也是旧名。
   *
   * 一张要人记得去加一行的清单，迟早会漏。所以改成扫全仓库：
   * 新加的文件自动在管辖范围内，不需要谁记得回来登记。
   */
  it('旧名字在用户看得见的地方一处不剩', () => {
    // .decisions/ 是历史记录，留着旧名是对的。brand.ts 和这个文件本身要提旧名才说得清。
    const SKIP = /node_modules|[\\/]\.git[\\/]|[\\/]data[\\/]|[\\/]dist[\\/]|\.decisions|brand\.(ts|test\.tsx?)$/;
    const TEXT = /\.(ts|tsx|js|mjs|json|md|html|css|webmanifest|cmd|command|sh|yml)$|^(启动|停止)/;

    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => {
        const p = join(dir, e.name);
        if (SKIP.test(p)) return [];
        return e.isDirectory() ? walk(p) : (TEXT.test(e.name) ? [p] : []);
      });

    const guilty = walk(root)
      .filter((p) => readFileSync(p, 'utf8').includes('发音诊室'))
      .map((p) => p.slice(root.length + 1));

    expect(guilty, `这些文件里还留着旧名字：${guilty.join('、')}`).toEqual([]);
  });

  it('副题说的是目标口音，不是一句空话', () => {
    expect(APP_TAGLINE).toContain('美式');
  });
});

/**
 * 侧栏版口上那个「源码」链接指向的地方，得跟 package.json 说的是同一个仓库。
 *
 * 这条跟上面那些是同一个毛病的不同面：一份事实散在两个文件里，
 * 改一处不会有任何报错——只不过这次坏掉的不是名字，是一个**点了会去到错地方**的链接。
 */
describe('源码链接指向的就是这个仓库', () => {
  it('跟 package.json 的 repository.url 是同一个', () => {
    const pkg = JSON.parse(read('package.json')) as { repository?: { url?: string } };
    const url = pkg.repository?.url ?? '';
    expect(url, 'package.json 里没有 repository.url 了').toBeTruthy();
    // package.json 那份是 git+https://…​.git，取出仓库本身来比
    const bare = url.replace(/^git\+/, '').replace(/\.git$/, '');
    expect(REPO_URL).toBe(bare);
  });

  it('侧栏真的把它渲染出来了，不是只定义了一个常量', () => {
    const layout = read('web/src/layout.tsx');
    expect(layout, '版口里没有用 REPO_URL').toContain('REPO_URL');
    expect(layout, '没有 GitHub 图标').toContain('GithubOutlined');
  });
});
