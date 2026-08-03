// `npm install` 的前置检查（npm 会自动先跑 preinstall），跟 check-uv.mjs 同一个路子：
// 把一句没有信息量的报错，换成一段能照着做的中文说明。
//
// **它挡掉了什么**：Node 太老时，better-sqlite3 没有对应的预编译二进制，npm 会转去
// 用 node-gyp 现场编译，然后在缺 MSVC 工具链的机器上倒在一屏英文里
// （`No prebuilt binaries found (target=20.x)` → `gyp ERR!` → MSBuild）。
// 实测过一次：那一屏跟"Node 版本不对"看不出任何关系，而双击启动的人只会读成"坏了"。
// npm 自己的 EBADENGINE 只是警告，不拦，而且照样是英文。
//
// **为什么不在启动脚本里解析 `node -v`**：三个平台要写三份版本比较，而且下限那个数
// 会跟 package.json 分裂成两处。这里从 engines 读，比较交给 node，一处判据、三个平台通用。
// 顺带绕开 `启动.cmd` 那两条硬规则（必须 CRLF、必须纯 ASCII）——那个文件里写不了中文。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 够不够下限。`engines` 的形状由 web/src/lib/nodeFloor.test.ts 钉着（必须是 `>=x.y.z`）；
 * 万一以后写成了复杂区间，这里**放行**而不是瞎猜——拦错人比不拦更糟。
 *
 * **逐段比，别拿字符串比**：`'22.9.0' >= '22.22.2'` 是 true，于是 22.9 被放行。
 * 这也是不在 .cmd / .command / .sh 里解析 `node -v` 的理由之一——那个比较要写三份。
 */
export function meetsFloor(version, range) {
  const m = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range ?? '');
  if (!m) return true;
  const need = m.slice(1, 4).map(Number);
  const have = version.split('.').map(Number);
  return have[0] !== need[0] ? have[0] > need[0]
    : have[1] !== need[1] ? have[1] > need[1]
      : have[2] >= need[2];
}

export function floorOf(range) {
  return /^>=(\d+\.\d+\.\d+)$/.exec(range ?? '')?.[1] ?? null;
}

// 只有被直接执行时才真的检查。测试要 import 上面那两个函数，而顶层的 process.exit
// 会把测试进程一起带走。**不用 import.meta.main**：它是新 Node 才有的，而这个脚本
// 存在的全部意义就是在**老 Node** 上跑得起来——在那儿它是 undefined，检查会被整个跳过。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  if (!meetsFloor(process.versions.node, pkg.engines?.node)) {
    console.error(报错文案(floorOf(pkg.engines.node)));
    process.exit(1);
  }
}

function 报错文案(floor) {
  return (
  [
    '',
    `Node 版本太低：这台机器上是 v${process.versions.node}，本工具需要 ${floor} 或更新。`,
    '',
    '直接装会倒在一屏英文报错里（缺预编译二进制 → 现场编译 → 缺编译器），',
    '那屏报错跟"版本不对"看不出关系，所以这里先拦下来。',
    '',
    '去 https://nodejs.org 下载 LTS 版本装上（会覆盖旧的，不用先卸载），',
    '装完把这个窗口关掉，重新双击启动就行。',
    '',
    `确认装好了没有：新开一个窗口敲 node -v，显示 v${floor} 以上就对了。`,
    '',
  ].join('\n')
  );
}
