import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `engines.node` 声明的下限，必须**每个依赖都真的允许**。
 *
 * 升个依赖就可能把下限顶上去，而本机毫无感觉（开发机版本高，一切正常）。
 * 踩过一次：engines 写着 `>=22.12`，当时的 jsdom 和 react-router 早就要 22.22 了，
 * 拿真的 22.12 跑——`npm ci` 只警告不拦，测试里 5 个文件的 worker 直接崩。
 * **装得上，跑不了。**
 *
 * **区间常常不连续**，所以只能逐个算、不能比大小：`20.x || 22.x || 23.x || …`
 * 这种写法里，奇数线是被跳过的；jsdom 某一版还出现过 `^24.15.0`——24.0–24.14 反而不行。
 * 只查直接依赖，间接的由 npm 自己警告。
 *
 * **这个文件查不出的那一类**：依赖声明允许某个 Node，却不为它发预编译二进制。
 * better-sqlite3 12.9.0 就是（它没有 Node 26 的 ABI 147 预编译包），所以本仓
 * 现在钉 12.11.1；那种只有 CI 里真装一遍才看得见。
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');

/** 够用的 semver 区间判断：只认这个仓库实际出现过的那几种写法 */
function satisfies(version: string, range: string): boolean {
  const [vMaj, vMin, vPatch] = version.split('.').map(Number);
  return range.split('||').map((r) => r.trim()).some((r) => {
    let m = /^(\d+)\.x$/.exec(r);              // 20.x
    if (m) return vMaj === Number(m[1]);
    m = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(r);   // ^22.22.2
    if (m) {
      if (vMaj !== Number(m[1])) return false;
      if (vMin !== Number(m[2])) return vMin > Number(m[2]);
      return (vPatch ?? 0) >= Number(m[3] ?? 0);
    }
    m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(r);  // >=22 / >=22.22.2
    if (m) {
      const [rMaj, rMin, rPatch] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
      if (vMaj !== rMaj) return vMaj > rMaj;
      if (vMin !== rMin) return vMin > rMin;
      return (vPatch ?? 0) >= rPatch;
    }
    return false;             // 没见过的写法：当成不满足，宁可假红也别放过
  });
}

describe('engines.node 声明的下限，每个依赖都得允许', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const declared: string | undefined = root.engines?.node;
  const floor = declared?.replace(/^>=\s*/, '') ?? '';

  it('前提：根 package.json 真的声明了下限，而且带到小版本', () => {
    expect(declared, 'package.json 没有 engines.node —— 这条守卫失去意义').toBeTruthy();
    expect(floor, '下限要精确到 x.y.z——实测过 22.12 装得上却跑不了').toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('那个下限，装上的每个直接依赖都允许', () => {
    const names = ['package.json', 'server/package.json', 'web/package.json'].flatMap((p) => {
      const j = JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
      return [...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})];
    });
    expect(names.length, '一个依赖都没读到，扫描面是空的').toBeGreaterThan(10);

    const blockers: string[] = [];
    let checked = 0;
    for (const name of new Set(names)) {
      const where = ['node_modules', 'server/node_modules', 'web/node_modules']
        .map((d) => join(ROOT, d, name, 'package.json')).find(existsSync);
      if (!where) continue;                       // 没装就跳过
      const range = JSON.parse(readFileSync(where, 'utf8')).engines?.node;
      if (!range) continue;                       // 没声明 = 不限制
      checked += 1;
      if (!satisfies(floor, range)) blockers.push(`${name}: engines.node = ${range}`);
    }

    expect(checked, '一个声明了 engines 的依赖都没查到，这条断言是空的').toBeGreaterThan(3);
    expect(blockers, `这些依赖不允许 Node ${floor}。要么把它们降回去，`
      + `要么把 engines.node / README / 启动提示 / CI 矩阵四处一起往上抬——`
      + `**并且在真的那个版本上跑一遍**，声明对了不等于跑得起来：\n  ${blockers.join('\n  ')}`)
      .toEqual([]);
  });

  // ── better-sqlite3 必须钉在 12.11.x ──
  //
  // **上面那条 engines 扫描看不见这个问题。** 12.9.0 的 engines 只写到 25.x，
  // 也没有 Node 26（ABI 147）的预编译包；12.11.1 同时有 24（137）和 26（147）
  // 的 win32-x64 预编译包。13.x 目前没有可用的 GitHub 预编译资产，不能放成 ^。
  //
  // 唯一真正查得出来的是 CI 里真的在 Node 24.15 和 Node 26 上各装一遍。
  it('better-sqlite3 钉在 12.11.x，不能放成 ^', () => {
    const spec: string = JSON.parse(
      readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'),
    ).dependencies['better-sqlite3'];
    expect(spec, `better-sqlite3 写成了 "${spec}"——^ 会装到 13.x，`
      + '13.x 目前没有可用的预编译资产，而且 12.9.0 也没有 Node 26 的 ABI 147')
      .toMatch(/^~12\.11\./);
  });

  // ── 声明了下限，还得有人拦 ──
  //
  // npm 自己的 EBADENGINE **只是警告，不拦**。Node 太老时真正发生的是：
  // better-sqlite3 找不到预编译二进制 → 转 node-gyp 现场编译 → 在没有 MSVC 的机器上
  // 倒在一屏英文里，而那屏东西跟"版本不对"看不出任何关系。
  // 双击启动的人只会读成"坏了"。
  it('preinstall 上挂着版本检查——npm 的 EBADENGINE 只警告不拦', () => {
    expect(root.scripts?.preinstall, 'preinstall 没了，Node 太老的人会撞进 node-gyp 那屏英文')
      .toContain('check-node');
    expect(existsSync(join(ROOT, 'scripts', 'check-node.mjs'))).toBe(true);
  });

  it('版本比较是逐段的，不是字符串比', async () => {
    const { meetsFloor } = await import('../../../scripts/check-node.mjs');
    // 这一条是全部理由：字符串比 '24.9.0' >= '24.15.0' 为 true，24.9 会被放行
    expect('24.9.0' >= '24.15.0', '前提变了：字符串比不再出错，这条用例可以撤').toBe(true);
    expect(meetsFloor('24.9.0', '>=24.15.0'), '24.9 < 24.15，逐段比才看得出').toBe(false);

    for (const v of ['20.20.2', '22.30.0', '24.14.9']) {
      expect(meetsFloor(v, '>=24.15.0'), `${v} 该被拦下`).toBe(false);
    }
    for (const v of ['24.15.0', '24.22.1', '26.12.1']) {
      expect(meetsFloor(v, '>=24.15.0'), `${v} 该放行`).toBe(true);
    }
    // 看不懂的区间就放行——拦错人比不拦更糟
    expect(meetsFloor('18.0.0', '^22 || >=24')).toBe(true);
  });

  it('CI 矩阵里跑的就是这个下限，不是另一个数', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci, 'CI 里没有 node 矩阵了，这条可以撤').toMatch(/node:\s*\[/);
    expect(ci, `CI 矩阵没跑 engines 声明的下限 ${floor}——那个数就没人验`)
      .toContain(`'${floor}'`);
  });
});
