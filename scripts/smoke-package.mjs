// 打包冒烟：在仓库外摆一份 resources 布局，用随包 node.exe 真起一次服务。
// 不依赖外网，也不碰真实 data/（它用临时 APP_ROOT）。
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverRuntimeResources } from './server-runtime-deps.mjs';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'zhengyin-smoke-'));
const res = join(tmp, 'res');
const appRoot = join(tmp, 'app');

const fail = (msg) => {
  console.error(`[smoke-package] ${msg}`);
  process.exitCode = 1;
};

const need = (p) => {
  if (!existsSync(join(root, p))) throw new Error(`缺 ${p}——先跑 npm run build 和 npm run fetch-runtime`);
};

try {
  need('server/dist');
  need('web/dist');
  need('desktop/vendor/node.exe');
  mkdirSync(join(res, 'server'), { recursive: true });
  mkdirSync(appRoot, { recursive: true });

  cpSync(join(root, 'server', 'dist'), join(res, 'server', 'dist'), { recursive: true });
  for (const { from, to } of serverRuntimeResources(root)) {
    cpSync(join(root, from), join(res, to), { recursive: true });
  }
  cpSync(join(root, 'web', 'dist'), join(res, 'web', 'dist'), { recursive: true });
  cpSync(join(root, 'notes'), join(res, 'notes'), { recursive: true });
  cpSync(join(root, 'workflows'), join(res, 'workflows'), { recursive: true });
  mkdirSync(join(res, 'asr-service'), { recursive: true });
  for (const f of ['main.py', 'pyproject.toml', 'uv.lock', '.python-version']) {
    cpSync(join(root, 'asr-service', f), join(res, 'asr-service', f));
  }
  mkdirSync(join(res, 'scripts'), { recursive: true });
  cpSync(join(root, 'scripts', 'vosk-models.json'), join(res, 'scripts', 'vosk-models.json'));
  cpSync(join(root, '发音档案.template.md'), join(res, '发音档案.template.md'));
  mkdirSync(join(res, 'runtime'), { recursive: true });
  cpSync(join(root, 'desktop', 'vendor', 'node.exe'), join(res, 'runtime', 'node.exe'));

  const port = await new Promise((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

  const child = spawn(join(res, 'runtime', 'node.exe'), [join(res, 'server', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SHIPPED_ROOT: res,
      APP_ROOT: appRoot,
      DATA_DIR: join(appRoot, 'data'),
      WEB_DIST: join(res, 'web', 'dist'),
      WORKFLOWS_DIR: join(res, 'workflows'),
      ASR_PROJECT_DIR: join(res, 'asr-service'),
      UV_PATH: join(res, 'runtime', 'uv.exe'),
      ASR_AUTOSTART: '0',
      NO_OPEN: '1',
      APP_RUNTIME: 'desktop',
      APP_VERSION: '1.0.0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });

  const base = `http://127.0.0.1:${port}`;
  const wait = async (path) => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return r;
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`等不到 ${path}。服务输出：\n${out}`);
  };

  try {
    await wait('/api/health');
    const runtime = await (await wait('/api/runtime')).json();
    if (runtime.desktop !== true) throw new Error('/api/runtime 没认出桌面模式');
    const asr = await (await wait('/api/asr/status')).json();
    if (asr.state !== 'off') throw new Error(`ASR_AUTOSTART=0 时应是 off，实际 ${asr.state}`);
    const before = await (await wait('/api/entries')).json();
    if (!Array.isArray(before.entries)) throw new Error('/api/entries 形状不对');
    const notes = await (await wait('/api/notes')).json();
    if (!notes.groups || typeof notes.groups !== 'object') throw new Error('/api/notes 形状不对');
    const phonemes = await (await wait('/api/phonemes')).json();
    if (!Array.isArray(phonemes.phones)) throw new Error('/api/phonemes 形状不对');
    console.log('[smoke-package] ok：服务、数据库、笔记与音素表都正常（不依赖外网）');
  } catch (e) {
    fail(e.message);
  } finally {
    child.kill();
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录下次会清 */ }
  }
} catch (e) {
  fail(e.message);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录下次会清 */ }
}
