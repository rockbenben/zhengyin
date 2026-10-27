// 算出 server 的运行时依赖闭包：从 server/package.json 的 dependencies 出发，
// 逐个走 node_modules 里的 package.json。打包配置与清单守卫共用这一份，
// 避免手抄 80 个传递依赖（漏一个的症状是打包全绿、装出来服务起不来）。
//
// 同一个包名可能有两份（npm 的版本冲突，例如 bl 自带一份 buffer）：两份都要带，
// 而且要把嵌套路径原样镜像到 resources/server/node_modules/ 下，否则 Node 解析不到。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

function resolvePackageDir(name, from) {
  let dir = from;
  for (;;) {
    const p = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(p)) return dirname(p);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function collect(root) {
  const found = new Map(); // name -> string[]
  const walk = (name, from) => {
    const dir = resolvePackageDir(name, from);
    if (!dir) throw new Error(`找不到运行时依赖 ${name}（从 ${from} 找起）`);
    const dirs = found.get(name) ?? [];
    if (dirs.includes(dir)) return;
    dirs.push(dir);
    found.set(name, dirs);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const d of Object.keys(pkg.dependencies ?? {})) walk(d, dir);
  };
  const srv = JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8'));
  for (const d of Object.keys(srv.dependencies ?? {})) walk(d, join(root, 'server'));
  return found;
}

export function serverRuntimeDeps(root) {
  return [...collect(root).keys()].sort();
}

export function serverRuntimeResources(root) {
  return [...collect(root).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, dirs]) => dirs.map((dir) => {
      const from = relative(root, dir);
      // resources 下是 server/node_modules/…；嵌套安装的包保留它原来的相对层级
      return { from, to: join('server', from) };
    }));
}
