import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `engines.node` 声明的下限，必须**每个依赖都真的允许**，而且 CI 和本机都跑在这条线上。
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
 * better-sqlite3 13.x 就是（engines 写 `>=22`、声明上允许 26，却没有可用的预编译
 * 资产），所以本仓现在钉 12.11.1；那种只有 CI 里真装一遍才看得见。
 *
 * **下限现在是 26.0.0**：26 是当前 LTS，也是桌面版随包 node.exe 的版本
 * （`desktop/vendor/`），打包 job 同样用 26。以前这里是 24.15、CI 跑 24.15 + 26
 * 两条线；并成一条是因为 better-sqlite3 的 ABI 按 Node 大版本走——本机一份
 * `node_modules` 只装得出一版原生二进制，测试和打桌面包来回切 Node，忘了重编的
 * 那一侧几百条用例会一起红在 `NODE_MODULE_VERSION` 上。代价是 Node 24 不再支持，
 * preinstall 会拦下并提示升级。
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

/** `26` 这种大版本写法补成 `26.0.0`：CI 和 `.nvmrc` 都允许只写大版本 */
function normalize(version: string): string {
  return /^\d+$/.test(version) ? `${version}.0.0` : version;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const declared: string | undefined = pkg.engines?.node;
const floor = declared?.replace(/^>=\s*/, '') ?? '';

describe('engines.node 声明的下限，每个依赖都得允许', () => {
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
      + `要么把 engines.node / README / 启动提示 / CI 四处一起往上抬——`
      + `**并且在真的那个版本上跑一遍**，声明对了不等于跑得起来：\n  ${blockers.join('\n  ')}`)
      .toEqual([]);
  });

  // ── better-sqlite3 必须钉在 12.11.x ──
  //
  // **上面那条 engines 扫描只管声明，查不出有没有预编译包。** 12.9.0 的 engines
  // 只写到 25.x（下限抬到 26 之后，它光凭声明就不合格）；12.11.1 有 26（147）的
  // win32-x64 预编译包。13.x 的 engines 是 `>=22`——声明上允许 26，却没有可用的
  // GitHub 预编译资产，不能放成 ^。
  //
  // 唯一真正查得出来的，是 CI 里真的在 Node 26 上装一遍。
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
  //
  // 同一道闸也挂在 pretest 上：preinstall 只管装依赖那一次，测试可能在换过 Node
  // 之后才跑——那正是 ABI 不匹配最常见的撞法。
  it('preinstall 和 pretest 都挂着版本检查——npm 的 EBADENGINE 只警告不拦', () => {
    expect(pkg.scripts?.preinstall, 'preinstall 没了，Node 太老的人会撞进 node-gyp 那屏英文')
      .toContain('check-node');
    expect(pkg.scripts?.pretest, 'pretest 没了，换过 Node 之后 npm test 会红成几百条 NODE_MODULE_VERSION')
      .toContain('check-node');
    expect(existsSync(join(ROOT, 'scripts', 'check-node.mjs'))).toBe(true);
  });

  it('版本比较是逐段的，不是字符串比', async () => {
    const { meetsFloor } = await import('../../../scripts/check-node.mjs');
    // 这一条是全部理由：字符串比 '26.9.0' >= '26.15.0' 为 true，26.9 会被放行
    expect('26.9.0' >= '26.15.0', '前提变了：字符串比不再出错，这条用例可以撤').toBe(true);
    expect(meetsFloor('26.9.0', '>=26.15.0'), '26.9 < 26.15，逐段比才看得出').toBe(false);

    for (const v of ['20.20.2', '24.15.0', '25.9.9']) {
      expect(meetsFloor(v, '>=26.0.0'), `${v} 该被拦下`).toBe(false);
    }
    for (const v of ['26.0.0', '26.12.1', '27.0.0']) {
      expect(meetsFloor(v, '>=26.0.0'), `${v} 该放行`).toBe(true);
    }
    // 看不懂的区间就放行——拦错人比不拦更糟
    expect(meetsFloor('18.0.0', '^22 || >=24')).toBe(true);
  });
});

/**
 * 下面两条守的是同一件事：本机与 CI 别跑在曲线外。
 *
 * 它们查的是**声明**，不是运行时——`npm test` 真跑在哪个 Node 上由 `pretest`
 * 那道闸负责（见上）。这里管的是"文件里写的版本别各说各的"。
 */
describe('CI 和本机的版本管理器都跑在声明的下限上', () => {
  it('CI 里出现的每个 node-version 都不低于下限', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];
    const versions = files.flatMap((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8');
      return [...text.matchAll(/node-version:\s*['"]?([0-9][0-9.]*)/g)].map((m) => m[1]);
    });
    expect(versions.length, 'CI 里没有 node-version 了，这条可以撤').toBeGreaterThan(0);

    const tooOld = versions.filter((v) => !satisfies(normalize(v), declared ?? ''));
    expect(tooOld, `CI 里有低于 engines 下限 ${floor} 的 Node：${tooOld.join('、')}——`
      + '原生模块一份 node_modules 只装得出一版，要么别跑那条线，要么把下限一起抬')
      .toEqual([]);
  });

  it('.nvmrc 钉的大版本也不低于下限', () => {
    const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc, '.nvmrc 空了，fnm / nvm 会退回机器上的默认 Node').toMatch(/^\d+(\.\d+){0,2}$/);
    expect(satisfies(normalize(nvmrc), declared ?? ''),
      `.nvmrc 写着 ${nvmrc}，低于下限 ${floor}——本机装出来的 better-sqlite3 `
      + '会和跑测试的 Node 差一个 ABI').toBe(true);
  });
});
