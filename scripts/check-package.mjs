// 校验「打包会带上的东西」与「编译产物真正会 require 的东西」是同一份。
// 跑之前先 npm run build（server/dist、web/dist 要有）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serverRuntimeDeps } from './server-runtime-deps.mjs';

const root = process.cwd();
const fail = (msg) => {
  console.error(`[check-package] ${msg}`);
  process.exit(1);
};

const dist = join(root, 'server', 'dist');
if (!existsSync(dist)) fail('server/dist 不存在——先跑 npm run build');

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const packageName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

const imports = new Set();
for (const file of walk(dist).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    imports.add(packageName(spec));
  }
}
const deps = new Set(serverRuntimeDeps(root));
const missing = [...imports].filter((n) => !deps.has(n));
if (missing.length) fail(`编译产物 import 了、但打包清单没带：${missing.join('、')}`);

for (const p of [
  'web/dist/index.html',
  'notes',
  'workflows',
  'asr-service/main.py',
  'asr-service/pyproject.toml',
  'asr-service/uv.lock',
  'asr-service/.python-version',
  '发音档案.template.md',
  'scripts/vosk-models.json',
  'desktop/vendor/node.exe',
  'desktop/vendor/uv.exe',
  'desktop/vendor/LICENSE-node.txt',
  'desktop/vendor/LICENSE-uv.txt',
]) {
  if (!existsSync(join(root, p))) fail(`缺 ${p}`);
}

if (!existsSync(join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))) {
  fail('better_sqlite3.node 不在——打包后服务会起不来');
}

const hash = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');
if (hash('desktop/build/icon.png') !== hash('web/public/icon-512.png')) fail('桌面图标与 PWA 图标不一致');

const bad = [];
for (const file of walk(dist).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8');
  if (/from\s+['"]\/src\//.test(text)) bad.push(relative(root, file));
}
if (bad.length) fail(`这些文件里有绝对源码路径：${bad.join('、')}`);

console.log(`[check-package] ok：${imports.size} 个裸 import、${deps.size} 个运行时依赖`);
