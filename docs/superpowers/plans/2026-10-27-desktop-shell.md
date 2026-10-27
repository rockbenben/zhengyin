# 正音桌面化 Implementation Plan（计划一）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让正音在 Windows x64 上作为一个 Electron 桌面应用运行：随包 Node 跑现有 Hono 服务，服务接管音素识别边车，能安装、能更新；浏览器模式保持可用。本计划不含任何 AI 代码。

**Architecture:** Electron 主进程只做路径、子进程、窗口、菜单与更新；服务仍是现有的 Hono 应用，用随包 `node.exe` 起（避开 better-sqlite3 的 Electron ABI 问题）；ASR 边车由服务拉起并随服务一起退出。浏览器模式与桌面版共用同一份服务端与前端代码，靠 `SHIPPED_ROOT` / `APP_ROOT` 两个根区分只读资源与可写数据。

**Tech Stack:** Electron + electron-builder + electron-updater；Hono + better-sqlite3；React/Vite + antd；uv + FastAPI 边车；Vitest。

**Spec:** `docs/superpowers/specs/2026-10-27-electron-ai-design.md`（执行前先读它；本计划从它出发，冲突时以 spec 为准并回报）

## Global Constraints

- 平台：**Windows x64 only**（首发）。NSIS + zip；自动更新只点亮 NSIS；zip 不初始化更新器。
- Node：服务端 `engines.node >= 20.19.0` 不变；CI 矩阵仍是 20.19 / 22 / 24。桌面打包 job 固定用与 `desktop/vendor/node.exe` 同大版本的 Node（24.x），因为 better-sqlite3 的 ABI 按大版本走。
- `better-sqlite3` 继续钉 `~12.9.0`，不许改成 `^`。
- 包管理与锁文件：npm + `package-lock.json`；CI 用 `npm ci`。
- 服务默认绑 `127.0.0.1`；浏览器模式端口默认 30031；ASR 端口动态，`ASR_PORT` 显式给了就固定。
- Electron 安全基线：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；权限只放 `media`；外链交给系统浏览器。
- 所有用户可见文案中文；不写「多听多练」这类空话；不做无依据的断言。
- 本计划不写任何 AI 代码（不建 provider 目录、不碰 AI 设置）。
- 根 `typecheck` 直接调 `tsc`，不能写成 `npm run typecheck -w …`（npm 10 的 PATH 问题）。
- 测试文件必须真的进 `vitest.config.ts` 的 include 名单；名单外等于永远不跑。
- 版本不凭记忆：Electron / electron-builder / electron-updater 用查询到的当前稳定版，记录在提交里；Action 用大版本标签，不装 Dependabot。

---

## 文件地图

**新建（服务端）**
- `server/src/runtime.ts` — 两个根与全部派生路径的解析（纯函数）
- `server/src/lock.ts` — 数据目录锁
- `server/src/net.ts` — 挑空闲端口 / 探测端口是否在听
- `server/src/audio/asrCommand.ts` — uv 命令、环境变量、版本下限
- `server/src/audio/asrManager.ts` — 边车状态机（起、接管、停、日志、重启）
- `server/src/csp.ts` — 生产环境的 CSP 头

**新建（桌面）**
- `desktop/package.json`、`desktop/tsconfig.json`、`desktop/tsconfig.typecheck.json`
- `desktop/electron-builder.config.mjs`（NSIS 基础配置 + 自动算出的服务端依赖）、`desktop/electron-builder-zip.config.mjs`（zip）
- `desktop/build/icon.png`（从 `web/public/icon-512.png` 复制）
- `desktop/src/paths.ts`、`logs.ts`、`serverChild.ts`、`settings.ts`、`firstRun.ts`、`links.ts`、`permissions.ts`、`updater.ts`、`menu.ts`、`main.ts`
- `desktop/冒烟清单.md`

**新建（脚本与守卫）**
- `scripts/fetch-runtime.mjs`、`scripts/runtime-versions.json`
- `scripts/check-package.mjs`、`scripts/smoke-package.mjs`
- `web/src/lib/desktopIdentity.test.ts`
- `.desktop-policy.json`、`.github/workflows/release.yml`

**修改（服务端）**
- `server/src/index.ts` — 用 `runtime`，起 ASR，绑 host，加锁
- `server/src/port.ts` — `serverPort(env)`、`serverHost(env)`
- `server/src/app.ts` — `AppDeps` 的 runtime/asr、`/api/runtime`、`/api/asr/status`、`/api/asr/restart`
- `server/src/audio/phonemeAsr.ts` — 端点按运行时端口
- `server/src/notes.ts` — 多根 NoteStore + `source`
- `server/src/profile.ts` — 笔记链接改成应用内路由
- `server/src/users.ts` — 档案模板可单独指定（`templateFile`）
- `server/src/models.ts` / `app.ts` — 备用模型清单改读 `shippedRoot`
- 各处测试的 deps fixture

**修改（前端）**
- `web/src/api.ts`、`web/src/types.ts` — runtime / asr status
- `web/src/components/AsrStatus.tsx` — 状态 + 日志 + 重启
- `web/src/pages/SettingsPage.tsx`、`SettingsPage.test.tsx` — 启停文案按运行时分叉
- `web/src/lib/brand.ts` — `localAppUrl()` 用 `location.hostname`
- `web/src/lib/brand.test.ts` — SKIP 加桌面产物目录

**修改（工程）**
- `package.json` — workspaces + 脚本
- `vitest.config.ts` — node 档加 `desktop/src/**/*.test.ts`
- `.gitignore`、`.gitattributes`、`.env.example`、`AGENTS.md`、`README.md`
- `停止.cmd` / `停止.command` / `停止.sh` 的注释
- `scripts/asr.mjs`（读 `ASR_PORT`）

---

## Task 1: 桌面 workspace 骨架、图标与身份守卫

**Files:**
- Create: `desktop/package.json`、`desktop/tsconfig.json`、`desktop/tsconfig.typecheck.json`、`desktop/build/icon.png`、`desktop/electron-builder.config.mjs`、`web/src/lib/desktopIdentity.test.ts`
- Modify: `package.json`（workspaces、脚本）、`vitest.config.ts`、`.gitignore`、`.gitattributes`、`.desktop-policy.json`

**Interfaces:**
- Consumes: 无
- Produces: `desktop` workspace 存在；`npm run typecheck` 覆盖它；`desktop/package.json` 的 identity 字段作为后续所有桌面文件的锚点。

- [ ] **Step 1: 写身份守卫（先红）**

```ts
// web/src/lib/desktopIdentity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME } from './brand';
import { createHash } from 'node:crypto';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('desktop/package.json'));

describe('桌面应用的身份字面量只有一处', () => {
  it('产品名与界面同名', () => {
    expect(pkg.productName).toBe(APP_NAME);
  });

  it('appId 是固定的 ASCII 反域名', () => {
    const cfg = read('desktop/electron-builder.config.mjs');
    expect(cfg).toContain("appId: 'com.rockbenben.zhengyin'");
  });

  it('author 必须是对象——字符串会让 exe 的 CompanyName 变成 GitHub, Inc.', () => {
    expect(typeof pkg.author).toBe('object');
    expect(pkg.author.name).toBe('rockbenben');
  });

  it('入口是 ESM，main 指向编译产物', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('dist/main.js');
  });

  it('图标就是仓库里那份 512×512，不另做资产', () => {
    const a = createHash('sha256').update(readFileSync(join(root, 'desktop/build/icon.png'))).digest('hex');
    const b = createHash('sha256').update(readFileSync(join(root, 'web/public/icon-512.png'))).digest('hex');
    expect(a).toBe(b);
    expect(existsSync(join(root, 'web/public/icon-512.png'))).toBe(true);
  });

  it('产物名全 ASCII 且自带扩展名占位', () => {
    const cfg = read('desktop/electron-builder.config.mjs');
    expect(cfg).toContain('zhengyin-${version}-win.${ext}');
    expect(cfg).toContain('zhengyin-${version}-win-setup.${ext}');
  });
});
```

- [ ] **Step 2: 跑它，确认因为文件不存在而红**

Run: `npx vitest run web/src/lib/desktopIdentity.test.ts`
Expected: FAIL（`ENOENT … desktop/package.json`）

- [ ] **Step 3: 查当前稳定版本并写进 `desktop/package.json`**

```bash
npm view electron version
npm view electron-builder version
npm view electron-updater version
```

把三条输出分别填进下面的 `devDependencies` / `dependencies`（不要凭记忆写版本）：

```json
{
  "name": "desktop",
  "productName": "正音",
  "version": "1.0.0",
  "private": true,
  "description": "正音的桌面外壳：窗口、更新、随包运行时",
  "author": { "name": "rockbenben" },
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.typecheck.json"
  },
  "devDependencies": {
    "electron": "<npm view electron version 的输出>",
    "electron-builder": "<npm view electron-builder version 的输出>"
  },
  "dependencies": {
    "electron-updater": "<npm view electron-updater version 的输出>"
  }
}
```

- [ ] **Step 4: 写两个 tsconfig、复制图标、接进根工程**

`desktop/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "outDir": "dist", "rootDir": "src",
    "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src"], "exclude": ["src/**/*.test.ts"]
}
```

`desktop/tsconfig.typecheck.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"],
  "exclude": []
}
```

```bash
mkdir -p desktop/build desktop/src
cp web/public/icon-512.png desktop/build/icon.png
```

根 `package.json` 的 `workspaces` 加 `"desktop"`，脚本加：

```json
"desktop": "npm run build && npm run build -w desktop && electron desktop/dist/main.js",
"dist:desktop": "npm run build && npm run build -w desktop && electron-builder --config desktop/electron-builder.config.mjs --publish never",
"dist:desktop:zip": "npm run build && npm run build -w desktop && electron-builder --config desktop/electron-builder-zip.config.mjs --publish never",
"fetch-runtime": "node scripts/fetch-runtime.mjs",
"check:package": "node scripts/check-package.mjs",
"smoke:package": "node scripts/smoke-package.mjs"
```

根 `typecheck` 末尾追加 `&& tsc -p desktop/tsconfig.typecheck.json`（直接调 tsc，不写 `-w`）。

开发时第一次跑桌面版前先 `npx install-electron` 取一次 Electron 二进制（Electron 42 起 npm install 不再代下）。

`vitest.config.ts` 的 node 档 include 加 `'desktop/src/**/*.test.ts'`。

`.gitignore` 追加：

```
desktop/vendor/
desktop/release/
desktop/release-zip/
.ai-reference/
```

`.gitattributes` 追加：

```
*.generated.ts text eol=lf
```

`.desktop-policy.json` 先落一版骨架（平台与更新偏离后面 Task 16 补全）：

```json
{
  "schemaVersion": 2,
  "status": "project-deviations",
  "framework": "electron",
  "channel": "stable",
  "platforms": ["windows-x64"],
  "packageManager": "npm (npm ci in CI; package-lock.json is the source of truth)",
  "node": "24 for desktop builds; server floor 20.19.0 (CI matrix 20.19/22/24)",
  "distribution": { "primary": "github-releases", "windows": "nsis + zip" },
  "updater": "electron-updater on NSIS only; zip is manual-update",
  "versionSource": "git tag vX.Y.Z; desktop/package.json asserted equal",
  "deviations": []
}
```

- [ ] **Step 5: 装依赖并跑守卫**

Run: `npm install && npm run typecheck && npx vitest run web/src/lib/desktopIdentity.test.ts`
Expected: PASS（第 5、6 条要读 `desktop/electron-builder.config.mjs`；先建一个只含 appId 与两条 artifactName 字面量的占位文件让它可读，Task 15 再补全）

- [ ] **Step 6: 提交**

```bash
git add desktop package.json package-lock.json vitest.config.ts .gitignore .gitattributes .desktop-policy.json web/src/lib/desktopIdentity.test.ts
git commit -m "feat(desktop): add the desktop workspace and pin its identity literals"
```

---

## Task 2: 服务端两个根与派生路径

**Files:**
- Create: `server/src/runtime.ts`、`server/src/runtime.test.ts`
- Modify: `server/src/port.ts`、`server/src/index.ts`、`server/src/users.ts`、`server/src/models.ts`、`server/src/app.ts`、`server/src/users.test.ts`

**Interfaces:**
- Consumes: `serverPort()`（Task 2 会加 env 参数）
- Produces:
  - `resolveRuntime(opts?): RuntimePaths`
  - `RuntimePaths` 字段：`shippedRoot` `appRoot` `dataDir` `envFile` `shippedNotes` `legacyNotes` `localNotes` `webDist` `workflowsDir` `asrProjectDir` `uvPath` `host` `port` `asrPort` `asrAutostart` `desktop` `version`
  - `UserManager` 新选项 `templateFile?: string`

- [ ] **Step 1: 写失败测试**

```ts
// server/src/runtime.test.ts
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveRuntime } from './runtime.js';

const cwd = resolve('/repo');

describe('resolveRuntime', () => {
  it('浏览器模式：仓库根就是两个根，本机笔记进 data/notes', () => {
    const r = resolveRuntime({ cwd, env: {}, exists: (p) => p === join(cwd, 'notes') });
    expect(r.appRoot).toBe(cwd);
    expect(r.shippedRoot).toBe(cwd);
    expect(r.dataDir).toBe(join(cwd, 'data'));
    expect(r.shippedNotes).toBe(join(cwd, 'notes'));
    expect(r.localNotes).toBe(join(cwd, 'data', 'notes'));
    expect(r.legacyNotes).toBeNull();
    expect(r.host).toBe('127.0.0.1');
    expect(r.port).toBe(30031);
    expect(r.asrPort).toBeNull();
    expect(r.asrAutostart).toBe(true);
    expect(r.desktop).toBe(false);
  });

  it('桌面模式：资源只读、数据在 appRoot，旧 notes 作为中间根', () => {
    const resources = resolve('/app/resources');
    const appRoot = resolve('/app/data-root');
    const r = resolveRuntime({
      cwd: resources,
      env: {
        SHIPPED_ROOT: resources, APP_ROOT: appRoot, APP_RUNTIME: 'desktop',
        APP_VERSION: '1.0.0', HOST: '0.0.0.0', PORT: '30100', ASR_PORT: '30101',
      },
      exists: (p) => p === join(appRoot, 'notes'),
    });
    expect(r.shippedNotes).toBe(join(resources, 'notes'));
    expect(r.legacyNotes).toBe(join(appRoot, 'notes'));
    expect(r.localNotes).toBe(join(appRoot, 'data', 'notes'));
    expect(r.webDist).toBe(join(resources, 'web', 'dist'));
    expect(r.workflowsDir).toBe(join(resources, 'workflows'));
    expect(r.asrProjectDir).toBe(join(resources, 'asr-service'));
    expect(r.host).toBe('0.0.0.0');
    expect(r.port).toBe(30100);
    expect(r.asrPort).toBe(30101);
    expect(r.desktop).toBe(true);
    expect(r.version).toBe('1.1.0');
  });

  it('每一项都能单独覆盖；ASR_AUTOSTART=0 关掉自启', () => {
    const r = resolveRuntime({
      cwd,
      env: {
        SHIPPED_NOTES: '/a', LEGACY_NOTES: '/b', LOCAL_NOTES: '/c',
        WEB_DIST: '/d', WORKFLOWS_DIR: '/e', ASR_PROJECT_DIR: '/f',
        UV_PATH: '/g/uv', ASR_AUTOSTART: '0', ENV_FILE: '/h/.env',
      },
      exists: () => false,
    });
    expect([r.shippedNotes, r.legacyNotes, r.localNotes, r.webDist, r.workflowsDir, r.asrProjectDir])
      .toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
    expect(r.uvPath).toBe('/g/uv');
    expect(r.envFile).toBe('/h/.env');
    expect(r.asrAutostart).toBe(false);
  });

  it('ASR_PORT 写坏了就明确失败，不静默落回默认', () => {
    expect(() => resolveRuntime({ cwd, env: { ASR_PORT: 'abc' } })).toThrow(/ASR_PORT/);
    expect(() => resolveRuntime({ cwd, env: { ASR_PORT: '70000' } })).toThrow(/ASR_PORT/);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/runtime.test.ts`
Expected: FAIL（`Cannot find module './runtime.js'`）

- [ ] **Step 3: 实现 `runtime.ts`，并给 `port.ts` 加 env 参数**

```ts
// server/src/runtime.ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serverHost, serverPort } from './port.js';

export interface RuntimeEnv { [key: string]: string | undefined }

export interface RuntimePaths {
  shippedRoot: string; appRoot: string; dataDir: string; envFile: string;
  shippedNotes: string; legacyNotes: string | null; localNotes: string;
  webDist: string; workflowsDir: string; asrProjectDir: string; uvPath: string;
  host: string; port: number; asrPort: number | null;
  asrAutostart: boolean; desktop: boolean; version: string;
}

export interface ResolveRuntimeOptions {
  env?: RuntimeEnv;
  cwd?: string;
  exists?: (p: string) => boolean;
}

export function defaultAppRoot(cwd: string, exists: (p: string) => boolean = existsSync): string {
  return exists(join(cwd, 'notes')) ? cwd : join(cwd, '..');
}

function portOrNull(raw: string | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`ASR_PORT 必须是 1–65535 的整数，现在是「${s}」`);
  }
  return n;
}

export function resolveRuntime(opts: ResolveRuntimeOptions = {}): RuntimePaths {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;

  const appRoot = resolve(env.APP_ROOT?.trim() || defaultAppRoot(cwd, exists));
  const shippedRoot = resolve(env.SHIPPED_ROOT?.trim() || appRoot);
  const dataDir = resolve(env.DATA_DIR?.trim() || join(appRoot, 'data'));
  const shippedNotes = resolve(env.SHIPPED_NOTES?.trim() || join(shippedRoot, 'notes'));

  const legacyCandidate = resolve(join(appRoot, 'notes'));
  const legacyNotes = env.LEGACY_NOTES?.trim()
    ? resolve(env.LEGACY_NOTES)
    : (legacyCandidate !== shippedNotes && exists(legacyCandidate) ? legacyCandidate : null);

  return {
    shippedRoot, appRoot, dataDir,
    envFile: resolve(env.ENV_FILE?.trim() || join(appRoot, '.env')),
    shippedNotes, legacyNotes,
    localNotes: resolve(env.LOCAL_NOTES?.trim() || join(dataDir, 'notes')),
    webDist: resolve(env.WEB_DIST?.trim() || join(shippedRoot, 'web', 'dist')),
    workflowsDir: resolve(env.WORKFLOWS_DIR?.trim() || join(shippedRoot, 'workflows')),
    asrProjectDir: resolve(env.ASR_PROJECT_DIR?.trim() || join(shippedRoot, 'asr-service')),
    uvPath: env.UV_PATH?.trim() || 'uv',
    host: serverHost(env),
    port: serverPort(env),
    asrPort: portOrNull(env.ASR_PORT),
    asrAutostart: env.ASR_AUTOSTART !== '0',
    desktop: env.APP_RUNTIME === 'desktop',
    version: env.APP_VERSION?.trim() || '',
  };
}
```

`port.ts`：

```ts
export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PORT) || DEFAULT_PORT;
}

export function serverHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOST?.trim() || '127.0.0.1';
}
```

- [ ] **Step 4: 把 `index.ts` 切到 runtime，并让 `UserManager`/`models` 读对根**

`index.ts` 顶部替换 `root`/`dataDir`/`webDist`/`envFile` 的来源：

```ts
import { resolveRuntime } from './runtime.js';
const runtime = resolveRuntime();
const { appRoot, dataDir, shippedNotes, legacyNotes, localNotes, webDist } = runtime;
mkdirSync(join(dataDir, 'audio'), { recursive: true });
```

`NoteStore` 仍在 Task 4 改多根，本任务先只传 `shippedNotes`（过渡）。
`createApp({ root: runtime.shippedRoot, envFile: runtime.envFile, ... })`。
`mwKey` 那行里的 `join(root, '.env')` 改成 `runtime.envFile`；`noteStore` 过渡期先 `new NoteStore(join(runtime.shippedNotes))`（Task 4 再切多根）。
`webDist` 那段 `if (existsSync(webDist))` 用 runtime 的值。

`users.ts` 的 `UserManagerOptions` 加：

```ts
/** 新用户档案模板。桌面版从只读资源根取，默认仍是 root 下那份 */
templateFile?: string;
```

并把 `const template = join(this.opts.root, "发音档案.template.md");` 改成：

```ts
const template = this.opts.templateFile ?? join(this.opts.root, "发音档案.template.md");
```

`index.ts` 构造 UserManager 时传 `root: runtime.appRoot`（旧版遗留文件在可写根里）与 `templateFile: join(runtime.shippedRoot, '发音档案.template.md')`。
`models.ts` 的 `loadRegistry(deps.root)` 保持不动；`deps.root` 现在语义是 `shippedRoot`，把 `AppDeps.root` 的注释改成「只读资源根，用来定位 scripts/vosk-models.json」。

- [ ] **Step 5: 跑类型检查与相关测试**

Run: `npm run typecheck && npx vitest run server/src/runtime.test.ts server/src/users.test.ts server/src/models.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/runtime.ts server/src/runtime.test.ts server/src/port.ts server/src/index.ts server/src/users.ts server/src/users.test.ts server/src/models.ts server/src/app.ts
git commit -m "feat(server): resolve a read-only asset root and a writable app root"
```

---

## Task 3: 数据目录锁

**Files:**
- Create: `server/src/lock.ts`、`server/src/lock.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Produces: `acquireDataLock(dataDir, opts?): LockHandle`；`DataLockBusyError`（带 `pid`/`host`）；`LockHandle.release()`

- [ ] **Step 1: 写失败测试**

```ts
// server/src/lock.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDataLock, DataLockBusyError } from './lock.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'lock-'));

describe('数据目录锁', () => {
  it('拿到锁之后写 pid，release 之后可以重新拿', () => {
    const dir = fresh();
    const a = acquireDataLock(dir, { pid: 111, host: 'h', alive: () => true });
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(111);
    a.release();
    const b = acquireDataLock(dir, { pid: 222, host: 'h', alive: () => true });
    b.release();
  });

  it('同一个目录、活着的进程 → 明确拒绝，并说清是谁', () => {
    const dir = fresh();
    acquireDataLock(dir, { pid: 111, host: 'h', alive: () => true });
    expect(() => acquireDataLock(dir, { pid: 222, host: 'h', alive: () => true }))
      .toThrow(DataLockBusyError);
    try { acquireDataLock(dir, { pid: 222, host: 'h', alive: () => true }); }
    catch (e) { expect((e as DataLockBusyError).pid).toBe(111); }
  });

  it('进程不在了就是残锁，接管', () => {
    const dir = fresh();
    acquireDataLock(dir, { pid: 111, host: 'h', alive: () => true });
    const b = acquireDataLock(dir, { pid: 222, host: 'h', alive: () => false });
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(222);
    b.release();
  });

  it('锁文件坏了也接管，不让人手删', () => {
    const dir = fresh();
    writeFileSync(join(dir, '.lock'), '{not json');
    const a = acquireDataLock(dir, { pid: 333, host: 'h', alive: () => true });
    expect(JSON.parse(readFileSync(join(dir, '.lock'), 'utf8')).pid).toBe(333);
    a.release();
  });

  it('release 幂等', () => {
    const dir = fresh();
    const a = acquireDataLock(dir, { pid: 1, host: 'h', alive: () => true });
    a.release(); a.release();
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/lock.test.ts`
Expected: FAIL（`Cannot find module './lock.js'`）

- [ ] **Step 3: 实现 `lock.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export class DataLockBusyError extends Error {
  constructor(readonly pid: number, readonly host: string, readonly file: string) {
    super(`这个数据文件夹正被另一个正音进程使用（pid ${pid}，${host}）。先关掉它再试。`);
    this.name = 'DataLockBusyError';
  }
}

export interface LockHandle { file: string; release(): void }

export interface LockOptions {
  pid?: number;
  host?: string;
  now?: () => string;
  alive?: (pid: number) => boolean;
}

interface LockFile { pid?: unknown; host?: unknown; startedAt?: unknown }

export function acquireDataLock(dataDir: string, opts: LockOptions = {}): LockHandle {
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const now = opts.now ?? (() => new Date().toISOString());
  const alive = opts.alive ?? ((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, '.lock');

  if (existsSync(file)) {
    let parsed: LockFile | null = null;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) as LockFile; } catch { parsed = null; }
    const otherPid = typeof parsed?.pid === 'number' ? parsed.pid : null;
    const otherHost = typeof parsed?.host === 'string' ? parsed.host : '';
    if (otherPid !== null && otherPid !== pid && otherHost === host && alive(otherPid)) {
      throw new DataLockBusyError(otherPid, otherHost || host, file);
    }
    rmSync(file, { force: true });
  }

  const body = JSON.stringify({ pid, host, startedAt: now() });
  try {
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DataLockBusyError(pid, host, file);
    }
    throw e;
  }

  let released = false;
  return {
    file,
    release() {
      if (released) return;
      released = true;
      rmSync(file, { force: true });
    },
  };
}
```

- [ ] **Step 4: 接进 `index.ts`，退出时释放**

```ts
import { acquireDataLock, DataLockBusyError } from './lock.js';
let lock: ReturnType<typeof acquireDataLock>;
try {
  lock = acquireDataLock(dataDir);
} catch (e) {
  if (e instanceof DataLockBusyError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const releaseLock = () => lock.release();
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
```

- [ ] **Step 5: 全量测试，修「同一个目录开两次服务」的用例**

Run: `npm test`
Expected: 锁测试 PASS；其余若红，按错误把用例改成各自独立的临时目录（不是把锁撤掉）。

- [ ] **Step 6: 提交**

```bash
git add server/src/lock.ts server/src/lock.test.ts server/src/index.ts server/src/*.test.ts
git commit -m "feat(server): refuse to open the same data directory twice"
```

---

## Task 4: 笔记多根与档案链接

**Files:**
- Modify: `server/src/notes.ts`、`server/src/notes.test.ts`、`server/src/app.test.ts`、`server/src/notes.shape.test.ts`、`server/src/profile.ts`、`server/src/profile.test.ts`、`server/src/shelf.test.ts`、`server/src/index.ts`

**Interfaces:**
- Produces:
  - `NoteSource = 'shipped' | 'legacy' | 'local'`
  - `NoteRoot { dir: string; source: NoteSource }`
  - `new NoteStore(roots: NoteRoot[])`
  - `Note.source: NoteSource`；`Note.file` 仍是裸文件名
  - `noteStore.dirs: string[]`

- [ ] **Step 1: 写多根测试（先红）**

```ts
// 追加到 server/src/notes.test.ts
describe('多根：优先级固定，不靠目录读取顺序', () => {
  it('同 id 时 local 盖过 legacy，legacy 盖过 shipped', () => {
    const shippedDir = mkdtempSync(join(tmpdir(), 'n-shipped-'));
    const legacyDir = mkdtempSync(join(tmpdir(), 'n-legacy-'));
    const localDir = mkdtempSync(join(tmpdir(), 'n-local-'));
    const note = (title: string) => `---\nid: same\ntitle: ${title}\ntriggers: [phoneme:l]\n---\n${title}\n`;
    writeFileSync(join(shippedDir, 'same.md'), note('shipped'));
    writeFileSync(join(legacyDir, 'same.md'), note('legacy'));
    writeFileSync(join(localDir, 'same.md'), note('local'));
    const s = new NoteStore([
      { dir: shippedDir, source: 'shipped' },
      { dir: legacyDir, source: 'legacy' },
      { dir: localDir, source: 'local' },
    ]);
    s.load();
    expect(s.get('same')?.title).toBe('local');
    expect(s.get('same')?.source).toBe('local');
    expect(s.warnings.join('\n')).toMatch(/local/);
  });

  it('不存在的根跳过；watch 要同时看多个目录', () => {
    const local = mkdtempSync(join(tmpdir(), 'n-local-'));
    const s = new NoteStore([
      { dir: join(local, 'missing'), source: 'shipped' },
      { dir: local, source: 'local' },
    ]);
    s.load();
    expect(s.dirs).toEqual([join(local, 'missing'), local]);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/notes.test.ts`
Expected: FAIL（`new NoteStore([...])` 按字符串处理，或类型错误）

- [ ] **Step 3: 改 `NoteStore` 为多根**

`notes.ts` 的 `Note` 加 `source`；构造与加载改成：

```ts
export type NoteSource = 'shipped' | 'legacy' | 'local';
export interface NoteRoot { dir: string; source: NoteSource }

export class NoteStore {
  private notes = new Map<string, Note>();
  private watcher: FSWatcher | undefined;
  warnings: string[] = [];
  private warn(msg: string): void { console.warn(msg); this.warnings.push(msg); }
  constructor(private roots: NoteRoot[]) {}

  get dirs(): string[] { return this.roots.map((r) => r.dir); }

  load(): void {
    const next = new Map<string, Note>();
    const warnings: string[] = [];
    const seen = new Map<string, Array<{ file: string; source: NoteSource }>>();
    for (const root of this.roots) {
      let files: string[];
      try { files = readdirSync(root.dir).filter((f) => f.endsWith('.md')); }
      catch (e) {
        if (root.source !== 'legacy') {
          warnings.push(`[notes] 读不到笔记目录 ${root.dir}（${(e as Error).message}），本次跳过这一根`);
        }
        continue;
      }
      for (const file of files) {
        try {
          const { data, content } = matter(readFileSync(join(root.dir, file), 'utf8'));
          if (!data.id || !data.title) { warnings.push(`[notes] 跳过（frontmatter 缺 id 或 title）: ${file}`); continue; }
          const id = String(data.id);
          next.set(id, {
            id, title: String(data.title),
            triggers: (Array.isArray(data.triggers) ? data.triggers : []).map(String),
            contrasts: (Array.isArray(data.contrasts) ? data.contrasts : []).map(String),
            words: (Array.isArray(data.words) ? data.words : []).map((w: unknown) => String(w).trim().toLowerCase()).filter(Boolean),
            severity: 'info', markdown: content.trim(), file, source: root.source,
          });
          seen.set(id, [...(seen.get(id) ?? []), { file, source: root.source }]);
        } catch (e) {
          warnings.push(`[notes] 解析失败: ${file}（${(e as Error)?.message ?? e}）`);
        }
      }
    }
    this.notes = next;
    this.warnings = warnings;
    for (const [id, entries] of seen) {
      if (entries.length < 2) continue;
      const winner = this.notes.get(id)!;
      this.warn(`[notes] id 冲突：id "${id}" 被 ${entries.length} 篇笔记声明——当前生效的是 ${winner.source} 根的 "${winner.file}"，其余（${entries.filter((e) => e.file !== winner.file || e.source !== winner.source).map((e) => `${e.source}/${e.file}`).join('、')}）被忽略`);
    }
    for (const warning of [...validateTriggers(this.all()), ...validateShape(this.all())]) this.warn(warning);
  }

  watch(onReload?: () => void): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.dirs, { ignoreInitial: true }).on('all', () => {
      this.load();
      try { onReload?.(); } catch (e) { console.warn('[notes] 重扫后的回调出错', e); }
    });
  }
}
```

注意保留原来的 per-file 告警细节（缺 trigger、解析失败）与 `validateTriggers`/`validateShape` 的调用；上面是骨架，照原实现搬过来。

- [ ] **Step 4: 更新所有构造点与 `profile.ts` 的链接**

生产构造（`index.ts`）：

```ts
const noteStore = new NoteStore([
  { dir: runtime.shippedNotes, source: 'shipped' },
  ...(runtime.legacyNotes ? [{ dir: runtime.legacyNotes, source: 'legacy' as const }] : []),
  { dir: runtime.localNotes, source: 'local' },
]);
```

测试里 `new NoteStore(dir)` 全部改成 `new NoteStore([{ dir, source: 'shipped' }])`；`app.test.ts` 里读 `(deps.noteStore as unknown as { dir: string }).dir` 的 8 处改成 `noteStore.dirs[0]`。

`profile.ts` 两处 `notes/${n.file}` 改成 `${localUrl()}/notes/${n.id}`（`localUrl` 从 `./port.js` import）。`profile.test.ts` 的断言从 `notes/l-vs-n.md` 改成 `/notes/l-vs-n)`（不绑端口）。

- [ ] **Step 5: 跑测试**

Run: `npm run typecheck && npx vitest run server/src/notes.test.ts server/src/notes.shape.test.ts server/src/profile.test.ts server/src/shelf.test.ts server/src/app.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/notes.ts server/src/notes.test.ts server/src/notes.shape.test.ts server/src/profile.ts server/src/profile.test.ts server/src/shelf.test.ts server/src/app.test.ts server/src/index.ts
git commit -m "feat(notes): load shipped, legacy and local notes with a fixed precedence"
```

---

## Task 5: 绑定本机、动态端口的客户端与提示

**Files:**
- Modify: `server/src/port.ts`、`server/src/index.ts`、`server/src/audio/phonemeAsr.ts`、`web/src/lib/brand.ts`、`web/src/lib/brand.test.ts`

**Interfaces:**
- Produces: `serverHost(env?)`（Task 2 已加）；`asrEndpoint(port)`；`localAppUrl()` 使用 `location.hostname`。

- [ ] **Step 1: 写测试**

`server/src/port.test.ts` 追加：

```ts
it('默认只绑本机，HOST 可显式放开', async () => {
  const { serverHost } = await import('./port.js');
  expect(serverHost({} as NodeJS.ProcessEnv)).toBe('127.0.0.1');
  expect(serverHost({ HOST: '0.0.0.0' } as NodeJS.ProcessEnv)).toBe('0.0.0.0');
  expect(serverHost({ HOST: '   ' } as NodeJS.ProcessEnv)).toBe('127.0.0.1');
});
```

`web/src/lib/brand.test.ts` 追加：

```ts
it('取不到页面地址时退回 localhost:30031；有 location.hostname 时跟它走', async () => {
  const { localAppUrl } = await import('./brand');
  expect(localAppUrl()).toBe('http://localhost:30031');
});
```

（jsdom 档里再测 `location.hostname` 的版本；node 档只测兜底。）

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/port.test.ts web/src/lib/brand.test.ts`
Expected: FAIL（`serverHost`/host 行为未实现）

- [ ] **Step 3: 实现**

`index.ts` 的 `serve`：

```ts
const server = serve({ fetch: app.fetch, port, hostname: runtime.host }, () => { ... });
```

`phonemeAsr.ts`：

```ts
export function asrEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}
```

`recognizePhonemes` / `checkPhonemeAsr` 增加 `port: number` 参数（默认 `Number(process.env.ASR_PORT) || 30032`），URL 用 `asrEndpoint(port)`。`app.ts` 调用时传 `deps.asr.port() ?? 30032`（Task 8 接）。

`brand.ts`：

```ts
export function localAppUrl(): string {
  const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
  const port = typeof location !== 'undefined' && location.port ? location.port : '30031';
  return `http://${host}:${port}`;
}
```

- [ ] **Step 4: 跑测试**

Run: `npm run typecheck && npx vitest run server/src/port.test.ts web/src/lib/brand.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/port.ts server/src/index.ts server/src/audio/phonemeAsr.ts web/src/lib/brand.ts web/src/lib/brand.test.ts server/src/port.test.ts
git commit -m "fix(server): bind to loopback by default and stop hardcoding the app host"
```

---

## Task 6: ASR 命令、环境与版本下限

**Files:**
- Create: `server/src/audio/asrCommand.ts`、`server/src/audio/asrCommand.test.ts`、`server/src/net.ts`、`server/src/net.test.ts`

**Interfaces:**
- Produces:
  - `MIN_UV_VERSION = '0.5.0'`
  - `parseUvVersion(output): [number, number, number] | null`
  - `uvVersionProblem(output): string | null`
  - `buildAsrCommand({ uvPath, projectDir, port, dataDir, baseEnv? }): { command, args, env }`
  - `pickFreePort(host?): Promise<number>`、`isPortListening(port, host?, timeoutMs?): Promise<boolean>`

- [ ] **Step 1: 写测试**

```ts
// server/src/audio/asrCommand.test.ts
import { describe, it, expect } from 'vitest';
import { buildAsrCommand, parseUvVersion, uvVersionProblem } from './asrCommand.js';

describe('ASR 命令', () => {
  it('冻结 lock、指定工程与 app-dir，venv/缓存/Python/pycache 全部重定向', () => {
    const c = buildAsrCommand({
      uvPath: 'C:/uv.exe', projectDir: 'C:/res/asr-service', port: 30123,
      dataDir: 'C:/root/data', baseEnv: { MODEL_SOURCE: 'modelscope' },
    });
    expect(c.command).toBe('C:/uv.exe');
    expect(c.args).toEqual([
      'run', '--frozen', '--project', 'C:/res/asr-service',
      'uvicorn', 'main:app', '--app-dir', 'C:/res/asr-service',
      '--host', '127.0.0.1', '--port', '30123',
    ]);
    expect(c.env.UV_PROJECT_ENVIRONMENT).toMatch(/data[\\/]asr[\\/]venv$/);
    expect(c.env.UV_CACHE_DIR).toMatch(/data[\\/]asr[\\/]uv-cache$/);
    expect(c.env.UV_PYTHON_INSTALL_DIR).toMatch(/data[\\/]asr[\\/]python$/);
    expect(c.env.PYTHONPYCACHEPREFIX).toMatch(/data[\\/]asr[\\/]pycache$/);
    expect(c.env.PYTHONIOENCODING).toBe('utf-8');
    expect(c.env.DISABLE_SAFETENSORS_CONVERSION).toBe('1');
    expect(c.env.MODEL_SOURCE).toBe('modelscope');
  });

  it('uv 版本解析与下限', () => {
    expect(parseUvVersion('uv 0.11.3 (45da18ac3 2026-04-01 x86_64-pc-windows-msvc)')).toEqual([0, 11, 3]);
    expect(uvVersionProblem('uv 0.11.3 (…)')).toBeNull();
    expect(uvVersionProblem('uv 0.4.9 (…)')).toMatch(/升级 uv/);
    expect(uvVersionProblem('不是版本')).toMatch(/uv/);
  });
});
```

```ts
// server/src/net.test.ts
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { isPortListening, pickFreePort } from './net.js';

describe('端口工具', () => {
  it('挑出来的端口能立刻绑上', async () => {
    const port = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const s = createServer().listen(port, '127.0.0.1', () => s.close(() => resolve()));
      s.on('error', reject);
    });
  });

  it('有人在听 → true；没人听 → false', async () => {
    const port = await pickFreePort();
    const s = createServer().listen(port, '127.0.0.1');
    await new Promise<void>((r) => s.once('listening', () => r()));
    expect(await isPortListening(port, '127.0.0.1')).toBe(true);
    await new Promise<void>((r) => s.close(() => r()));
    expect(await isPortListening(port, '127.0.0.1', 200)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/audio/asrCommand.test.ts server/src/net.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现两个模块**

`asrCommand.ts`：

```ts
import { join } from 'node:path';

export const MIN_UV_VERSION = '0.5.0';

export function parseUvVersion(output: string): [number, number, number] | null {
  const m = /\buv\s+(\d+)\.(\d+)\.(\d+)/i.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function uvVersionProblem(output: string): string | null {
  const v = parseUvVersion(output);
  if (!v) return `看不懂 uv 的版本（它说的是「${output.trim().slice(0, 80)}」）。装一个新的 uv 再试。`;
  const min = MIN_UV_VERSION.split('.').map(Number);
  const older = v[0] !== min[0] ? v[0] < min[0] : v[1] !== min[1] ? v[1] < min[1] : v[2] < min[2];
  return older ? `uv ${v.join('.')} 太旧了，识别服务要 ${MIN_UV_VERSION} 以上。升级 uv 再试。` : null;
}

export interface AsrCommandInput {
  uvPath: string; projectDir: string; port: number; dataDir: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildAsrCommand(input: AsrCommandInput): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const asrData = join(input.dataDir, 'asr');
  return {
    command: input.uvPath,
    args: [
      'run', '--frozen', '--project', input.projectDir,
      'uvicorn', 'main:app', '--app-dir', input.projectDir,
      '--host', '127.0.0.1', '--port', String(input.port),
    ],
    env: {
      ...input.baseEnv,
      UV_PROJECT_ENVIRONMENT: join(asrData, 'venv'),
      UV_CACHE_DIR: join(asrData, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(asrData, 'python'),
      PYTHONPYCACHEPREFIX: join(asrData, 'pycache'),
      PYTHONIOENCODING: 'utf-8',
      DISABLE_SAFETENSORS_CONVERSION: '1',
    },
  };
}
```

`net.ts`：

```ts
import { createServer, connect } from 'node:net';

export function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolve(port));
      } else { s.close(() => reject(new Error('没能挑到空闲端口'))); }
    });
  });
}

export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run server/src/audio/asrCommand.test.ts server/src/net.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/audio/asrCommand.ts server/src/audio/asrCommand.test.ts server/src/net.ts server/src/net.test.ts
git commit -m "feat(asr): build the sidecar command with writable runtime dirs"
```

---

## Task 7: ASR 管理器

**Files:**
- Create: `server/src/audio/asrManager.ts`、`server/src/audio/asrManager.test.ts`

**Interfaces:**
- Consumes: `buildAsrCommand`、`uvVersionProblem`、`pickFreePort`、`isPortListening`
- Produces:

```ts
export type AsrState = 'off' | 'no-uv' | 'starting' | 'ready' | 'error';
export interface AsrStatus {
  state: AsrState; port: number | null; uvFound: boolean;
  startedAt: number | null; error: string | null; log: string[];
}
export class AsrManager {
  constructor(opts: AsrManagerOptions)
  status(): AsrStatus
  start(): Promise<void>
  restart(): Promise<void>
  stop(): void
  port(): number | null
}
```

- [ ] **Step 1: 写状态机测试（用假 spawn / 假 fetch / 假时钟）**

```ts
// server/src/audio/asrManager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AsrManager } from './asrManager.js';

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: () => void };
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4242;
  c.kill = vi.fn();
  return c;
}

const base = () => ({
  projectDir: '/res/asr-service', uvPath: 'uv', dataDir: '/data',
  explicitPort: null as number | null, autostart: true,
  probeUv: () => ({ found: true, output: 'uv 0.11.3 (x)' }),
  pickPort: async () => 30123,
  isListening: async () => false,
  fetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
  spawn: vi.fn(() => fakeChild()),
  killTree: vi.fn(),
  sleep: async () => {},
});

describe('AsrManager', () => {
  it('autostart 关掉 → off，不 spawn', async () => {
    const o = { ...base(), autostart: false };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('off');
    expect(o.spawn).not.toHaveBeenCalled();
  });

  it('没有 uv → no-uv，不 spawn', async () => {
    const o = { ...base(), probeUv: () => ({ found: false, output: '' }) };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('no-uv');
    expect(o.spawn).not.toHaveBeenCalled();
  });

  it('uv 太旧 → error，说升级', async () => {
    const o = { ...base(), probeUv: () => ({ found: true, output: 'uv 0.4.9 (x)' }) };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toMatch(/升级 uv/);
  });

  it('起进程、日志进环形缓冲、健康后 ready', async () => {
    const o = base();
    const m = new AsrManager(o);
    await m.start();
    expect(o.spawn).toHaveBeenCalledOnce();
    const child = (o.spawn as any).mock.results[0].value as ReturnType<typeof fakeChild>;
    child.stderr.emit('data', Buffer.from('\u001b[31m模型加载中\u001b[0m\n'));
    expect(m.status().log.join('')).toContain('模型加载中');
    await new Promise((r) => setTimeout(r, 0));
    expect(m.status().state).toBe('ready');
    expect(m.status().port).toBe(30123);
  });

  it('显式端口有人在听 → 接管，不 spawn', async () => {
    const o = { ...base(), explicitPort: 30032, isListening: async () => true };
    const m = new AsrManager(o);
    await m.start();
    expect(o.spawn).not.toHaveBeenCalled();
    expect(m.status().port).toBe(30032);
  });

  it('显式端口被别的程序占着（不是我们的 /health）→ error', async () => {
    const o = {
      ...base(), explicitPort: 30032, isListening: async () => true,
      fetch: vi.fn(async () => { throw new Error('not ours'); }),
    };
    const m = new AsrManager(o);
    await m.start();
    expect(m.status().state).toBe('error');
    expect(m.status().error).toMatch(/占/);
  });

  it('stop 按进程树杀、幂等、状态回 off', async () => {
    const o = base();
    const m = new AsrManager(o);
    await m.start();
    m.stop(); m.stop();
    expect(o.killTree).toHaveBeenCalledTimes(1);
    expect(m.status().state).toBe('off');
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/audio/asrManager.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `asrManager.ts`**

```ts
import { spawn as spawnChild, spawnSync, type ChildProcess } from 'node:child_process';
import { buildAsrCommand, uvVersionProblem } from './asrCommand.js';
import { isPortListening, pickFreePort } from '../net.js';

export type AsrState = 'off' | 'no-uv' | 'starting' | 'ready' | 'error';

export interface AsrStatus {
  state: AsrState; port: number | null; uvFound: boolean;
  startedAt: number | null; error: string | null; log: string[];
}

export interface AsrManagerOptions {
  projectDir: string; uvPath: string; dataDir: string;
  explicitPort: number | null; autostart: boolean;
  /** .env 里的 MODEL_SOURCE / HF_ENDPOINT 等，由调用方合并进来 */
  baseEnv?: NodeJS.ProcessEnv;
  probeUv: () => { found: boolean; output: string };
  pickPort?: () => Promise<number>;
  isListening?: (port: number, host: string) => Promise<boolean>;
  fetch?: typeof fetch;
  spawn?: typeof spawnChild;
  killTree?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_LOG = 300;
const ANSI = /\u001b\[[0-9;]*m/g;

export class AsrManager {
  private state: AsrState = 'off';
  private portNo: number | null = null;
  private uvFound = false;
  private startedAt: number | null = null;
  private error: string | null = null;
  private log: string[] = [];
  private child: ChildProcess | null = null;
  private runId = 0;
  private stopping = false;

  constructor(private o: AsrManagerOptions) {}

  status(): AsrStatus {
    return { state: this.state, port: this.portNo, uvFound: this.uvFound, startedAt: this.startedAt, error: this.error, log: [...this.log] };
  }

  port(): number | null { return this.portNo; }

  private push(text: string): void {
    for (const line of text.replace(ANSI, '').split(/[\r\n]+/)) {
      const s = line.trimEnd();
      if (!s) continue;
      this.log.push(s);
      if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.error = null;
    if (!this.o.autostart) { this.state = 'off'; return; }

    const uv = this.o.probeUv();
    this.uvFound = uv.found;
    if (!uv.found) { this.state = 'no-uv'; return; }
    const bad = uvVersionProblem(uv.output);
    if (bad) { this.state = 'error'; this.error = bad; this.push(bad); return; }

    const fetchFn = this.o.fetch ?? fetch;
    const listening = this.o.isListening ?? isPortListening;
    const explicit = this.o.explicitPort;

    // 显式端口：有人在听 → 先问一句是不是我们的边车
    if (explicit !== null && await listening(explicit, '127.0.0.1')) {
      try {
        const r = await fetchFn(`http://127.0.0.1:${explicit}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await r.json() as { ok?: unknown };
        if (typeof body.ok === 'boolean') {
          this.portNo = explicit;
          this.state = 'starting';
          this.startedAt = (this.o.now ?? Date.now)();
          void this.waitReady(explicit, ++this.runId);
          return;
        }
      } catch { /* 不是我们的，落到下面报错 */ }
      this.state = 'error';
      this.error = `端口 ${explicit} 被别的程序占着。关掉它，或在 .env 里换一个 ASR_PORT。`;
      this.push(this.error);
      return;
    }

    const port = explicit ?? await (this.o.pickPort ?? pickFreePort)();
    this.portNo = port;
    this.startedAt = (this.o.now ?? Date.now)();
    const cmd = buildAsrCommand({
      uvPath: this.o.uvPath, projectDir: this.o.projectDir, port, dataDir: this.o.dataDir, baseEnv: this.o.baseEnv ?? process.env,
    });

    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? spawnChild)(cmd.command, cmd.args, {
        env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (e) {
      this.state = 'error'; this.error = `起不了识别服务：${(e as Error).message}`; this.push(this.error); return;
    }

    this.child = child;
    this.state = 'starting';
    const id = ++this.runId;
    child.stdout?.on('data', (b: Buffer) => this.push(b.toString()));
    child.stderr?.on('data', (b: Buffer) => this.push(b.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (id !== this.runId) return;
      this.state = 'error'; this.error = `起不了识别服务：${e.message}`; this.push(this.error);
    });
    child.on('exit', (code) => {
      if (id !== this.runId || this.stopping) return;
      this.state = 'error';
      this.error = `识别服务退出了（退出码 ${code ?? '未知'}）。日志里最后几行通常能看出原因。`;
      this.push(this.error);
    });
    void this.waitReady(port, id);
  }

  private async waitReady(port: number, id: number): Promise<void> {
    const fetchFn = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (id === this.runId && !this.stopping) {
      try {
        const r = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        const body = await r.json() as { ok?: unknown };
        if (body.ok === true) { this.state = 'ready'; return; }
      } catch { /* 还没起来，继续等 */ }
      await sleep(1000);
    }
  }

  stop(): void {
    if (this.stopping && this.child === null) { this.state = 'off'; return; }
    this.stopping = true;
    this.runId += 1;
    const pid = this.child?.pid;
    try { this.child?.kill(); } catch { /* 已经退了 */ }
    if (pid) (this.o.killTree ?? defaultKillTree)(pid);
    this.child = null;
    this.state = 'off';
  }

  async restart(): Promise<void> {
    this.stop();
    this.state = 'off';
    await this.start();
  }
}

export function defaultKillTree(pid: number): void {
  if (process.platform === 'win32') {
    // 同步执行，退出流程里没时间等 Promise
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
```

（`defaultKillTree` 已在文件顶层 import `spawnSync`，不要在 ESM 里用 `require`。）

- [ ] **Step 4: 跑测试**

Run: `npx vitest run server/src/audio/asrManager.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/audio/asrManager.ts server/src/audio/asrManager.test.ts
git commit -m "feat(asr): manage the phoneme sidecar lifecycle in the server"
```

---

## Task 8: ASR 接口、接线与启动脚本

**Files:**
- Modify: `server/src/app.ts`、`server/src/index.ts`、`server/src/app.test.ts`、`server/src/users.integration.test.ts`、`package.json`、`scripts/asr.mjs`
- Create: `scripts/dev-server.mjs`、`web/src/lib/desktopScripts.test.ts`

**Interfaces:**
- Consumes: `AsrManager`
- Produces: `AppDeps.asr`；`GET /api/asr/status`；`POST /api/asr/restart`

- [ ] **Step 1: 写接口测试与脚本守卫（先红）**

在**两个** deps fixture（`app.test.ts` 与 `users.integration.test.ts`）里把 `checkPhonemeAsr` / `hasUv` 换成一个 `asr`：

```ts
asr: {
  status: () => ({ state: 'ready' as const, port: 30032, uvFound: true, startedAt: 0, error: null, log: [] }),
  restart: vi.fn().mockResolvedValue(undefined),
},
```

追加：

```ts
it('GET /api/asr/status 原样给状态与日志', async () => {
  const res = await app.request('/api/asr/status');
  expect(res.status).toBe(200);
  expect((await res.json()).state).toBe('ready');
});

it('POST /api/asr/restart 调管理器，不在接口里起进程', async () => {
  const res = await app.request('/api/asr/restart', { method: 'POST' });
  expect(res.status).toBe(200);
  expect(deps.asr.restart).toHaveBeenCalledOnce();
});
```

`web/src/lib/desktopScripts.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..', '..', '..');

describe('启动脚本不再各自拉边车', () => {
  it('npm start 只起服务；dev 用包装脚本关掉服务的自启', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.start).not.toContain('concurrently');
    expect(pkg.scripts.start).not.toContain('asr');
    expect(pkg.scripts.dev).toContain('scripts/dev-server.mjs');
    expect(pkg.scripts.dev).toContain('npm run --silent asr');
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/app.test.ts web/src/lib/desktopScripts.test.ts`
Expected: FAIL（`asr` 不在 AppDeps / 脚本还是旧写法）

- [ ] **Step 3: 改 `app.ts` 与 `index.ts`**

`AppDeps` 删掉 `checkPhonemeAsr` / `hasUv`，加：

```ts
asr: { status: () => AsrStatus; restart: () => Promise<void> };
```

路由：

```ts
app.get('/api/asr/status', (c) => c.json(deps.asr.status()));
app.post('/api/asr/restart', async (c) => {
  await deps.asr.restart();
  return c.json(deps.asr.status());
});
```

`/api/pronounce/health`：

```ts
app.get('/api/pronounce/health', (c) => {
  const s = deps.asr.status();
  return c.json({ ok: s.state === 'ready', uv: s.uvFound });
});
```

`/api/pronounce` 里 `deps.recognizePhonemes(audio)` 改成 `deps.recognizePhonemes(audio, fetch, 60_000, deps.asr.status().port ?? 30032)`；如果状态是 `no-uv`，直接 503 说「这台机器没有 uv」而不是去连一个不存在的端口。

`index.ts`：

```ts
import { AsrManager } from './audio/asrManager.js';
import { probeUv } from './audio/asrCommand.js';
const envText = readEnvFile(runtime.envFile);
const modelSource = readEnvValue(envText, 'MODEL_SOURCE');
const hfEndpoint = readEnvValue(envText, 'HF_ENDPOINT');
const asr = new AsrManager({
  projectDir: runtime.asrProjectDir,
  uvPath: runtime.uvPath,
  dataDir: runtime.dataDir,
  explicitPort: runtime.asrPort,
  autostart: runtime.asrAutostart,
  baseEnv: {
    ...process.env,
    ...(modelSource ? { MODEL_SOURCE: modelSource } : {}),
    ...(hfEndpoint ? { HF_ENDPOINT: hfEndpoint } : {}),
  },
  probeUv: () => probeUv(runtime.uvPath),
});
// createApp({ ... asr: { status: () => asr.status(), restart: () => asr.restart() } })
// serve(...) 之后：
if (runtime.asrAutostart) void asr.start();
// 退出时：asr.stop();
```

（`probeUv` 放进 `asrCommand.ts`：先 `spawnSync(uvPath, ['--version'], { encoding: 'utf8' })`（打包后的路径可能带空格，参数数组不会被拆开）；失败再退回 `spawnSync(\`\"${uvPath}\" --version\`, { shell: true, encoding: 'utf8' })` 照顾 `.cmd` shim。找不到回 `{found:false, output:''}`。）

- [ ] **Step 4: 改启动脚本**

`scripts/dev-server.mjs`：

```js
import { spawn } from 'node:child_process';
const child = spawn('npm', ['run', 'dev', '-w', 'server'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ASR_AUTOSTART: '0' },
});
child.on('exit', (code) => process.exit(code ?? 0));
```

根 `package.json`：

```json
"dev": "concurrently -n server,web,asr -c cyan,green,magenta \"node scripts/dev-server.mjs\" \"npm run dev -w web\" \"npm run --silent asr\"",
"start": "node server/dist/index.js"
```

`scripts/asr.mjs` 的端口改成 `process.env.ASR_PORT || 30032`（命令行字符串里用模板插值）。

- [ ] **Step 5: 跑测试**

Run: `npm run typecheck && npx vitest run server/src/app.test.ts web/src/lib/desktopScripts.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/app.ts server/src/index.ts server/src/app.test.ts package.json scripts/dev-server.mjs scripts/asr.mjs web/src/lib/desktopScripts.test.ts server/src/audio/asrCommand.ts
git commit -m "feat(asr): expose status and restart, and let the server own the sidecar"
```

---

## Task 9: `/api/runtime` 与识别服务状态界面

**Files:**
- Modify: `server/src/app.ts`、`server/src/app.test.ts`、`server/src/index.ts`、`web/src/types.ts`、`web/src/api.ts`、`web/src/components/AsrStatus.tsx`
- Create: `web/src/components/AsrStatus.test.tsx`

**Interfaces:**
- Consumes: `RuntimePaths`、`AsrStatus`
- Produces: `GET /api/runtime` 返回 `{ desktop, version, appRoot, userNotes }`；`api.runtime()`、`api.asrStatus()`、`api.asrRestart()`

- [ ] **Step 1: 写失败测试**

`server/src/app.test.ts` 追加：

```ts
it('GET /api/runtime 给桌面标志与两个路径', async () => {
  const res = await app.request('/api/runtime');
  expect(await res.json()).toEqual({
    desktop: false, version: '', appRoot: '/repo', userNotes: '/repo/data/notes',
  });
});
```

（两个 deps fixture——`app.test.ts` 与 `users.integration.test.ts`——都加 `runtime: { desktop: false, version: '', appRoot: '/repo', userNotes: '/repo/data/notes' }`。）

`web/src/components/AsrStatus.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AsrStatus from './AsrStatus';
import { api } from '../api';

beforeEach(() => vi.restoreAllMocks());

it('starting：摊开日志、给重启按钮，不说“看黑窗口”', async () => {
  vi.spyOn(api, 'asrStatus').mockResolvedValue({
    state: 'starting', port: 30123, uvFound: true, startedAt: Date.now(),
    error: null, log: ['模型不在本地缓存里，开始获取', 'Downloading 12%'],
  });
  render(<AsrStatus pollMs={10_000} />);
  expect(await screen.findByText(/正在启动|加载模型/)).toBeTruthy();
  expect(screen.getByText(/Downloading 12%/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /重启/ })).toBeTruthy();
  expect(document.body.textContent).not.toContain('黑窗口');
});

it('error：原样给出错误与日志', async () => {
  vi.spyOn(api, 'asrStatus').mockResolvedValue({
    state: 'error', port: null, uvFound: true, startedAt: null,
    error: '识别服务退出了（退出码 1）', log: ['ModuleNotFoundError: torch'],
  });
  render(<AsrStatus pollMs={10_000} />);
  expect(await screen.findByText(/退出码 1/)).toBeTruthy();
  expect(screen.getByText(/ModuleNotFoundError/)).toBeTruthy();
});

it('ready：安静，不占版面', async () => {
  vi.spyOn(api, 'asrStatus').mockResolvedValue({
    state: 'ready', port: 30123, uvFound: true, startedAt: 1, error: null, log: [],
  });
  const { container } = render(<AsrStatus pollMs={10_000} />);
  await waitFor(() => expect(container.textContent).toBe(''));
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run server/src/app.test.ts web/src/components/AsrStatus.test.tsx`
Expected: FAIL（路由与 api 方法不存在）

- [ ] **Step 3: 实现服务端路由与 web 类型/api**

`AppDeps` 加：

```ts
runtime: { desktop: boolean; version: string; appRoot: string; userNotes: string };
```

`app.ts`：

```ts
app.get('/api/runtime', (c) => c.json(deps.runtime));
```

`index.ts` 传：

```ts
runtime: {
  desktop: runtime.desktop, version: runtime.version,
  appRoot: runtime.appRoot, userNotes: runtime.localNotes,
},
```

`web/src/types.ts`：

```ts
export interface RuntimeInfo { desktop: boolean; version: string; appRoot: string; userNotes: string }
export type AsrState = 'off' | 'no-uv' | 'starting' | 'ready' | 'error';
export interface AsrStatusInfo {
  state: AsrState; port: number | null; uvFound: boolean;
  startedAt: number | null; error: string | null; log: string[];
}
```

`web/src/api.ts`：

```ts
runtime: () => j<T.RuntimeInfo>(fetch('/api/runtime')),
asrStatus: () => j<T.AsrStatusInfo>(fetch('/api/asr/status')),
asrRestart: () => j<T.AsrStatusInfo>(fetch('/api/asr/restart', { method: 'POST' })),
```

- [ ] **Step 4: 重写 `AsrStatus.tsx`**

要点（照这个结构写全）：

```tsx
export default function AsrStatus({ pollMs = 2000 }: { pollMs?: number } = {}) {
  const [s, setS] = useState<T.AsrStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelState, setModelState] = useState<ModelAvailability>('checking');

  useEffect(() => { checkModelAvailability().then(setModelState).catch(() => setModelState('error')); }, []);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = () => api.asrStatus().then((r) => {
      if (!alive) return;
      setS(r);
      if (r.state === 'starting') timer = setTimeout(ask, pollMs);
    }).catch(() => { if (alive) timer = setTimeout(ask, pollMs); });
    ask();
    return () => { alive = false; if (timer !== null) clearTimeout(timer); };
  }, [pollMs]);

  if (!s || s.state === 'ready') {
    return s?.state === 'ready' && modelState === 'error'
      ? <Notice tone="quiet" title="备用识别模型检测失败">不影响音素级评测，只是主服务挂掉时没有退路。</Notice>
      : null;
  }

  const log = <details style={{ marginTop: 8 }}>
    <summary>识别服务日志（最近 {s.log.length} 行）</summary>
    <pre className="mono-note" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{s.log.join('\n')}</pre>
  </details>;
  const restart = <Button size="small" loading={busy} onClick={async () => {
    setBusy(true);
    try { setS(await api.asrRestart()); } finally { setBusy(false); }
  }}>重启识别服务</Button>;

  if (s.state === 'starting') return <Notice tone="quiet" label="正在启动" title="音素识别服务正在准备，好了会自己变">
    首次使用要下约 1.2GB 模型；下面能看到它走到哪一步。{log}{restart}
  </Notice>;

  if (s.state === 'no-uv') return <Notice tone="warn" label="逐音素评测没开" title="这台机器没有可用的 uv">
    桌面版安装包里应自带 uv —— 没有的话多半是安装不完整，重新安装一次；浏览器模式按下面的方式装。{log}{restart}
  </Notice>;

  if (s.state === 'off') return <Notice tone="quiet" label="逐音素评测没开" title="开发模式下由 npm run asr 单独启动">
    服务没有托管识别服务（`ASR_AUTOSTART=0`）。{log}
  </Notice>;

  return <Notice tone="warn" label="逐音素评测没开" title="识别服务出错了">
    {s.error ?? '原因不明。'}{log}{restart}
  </Notice>;
}
```

（`Button` 从 antd import；`mono-note` 是现成类。`Notice` 的 props 照现有用法。）

- [ ] **Step 5: 跑测试**

Run: `npm run typecheck && npx vitest run server/src/app.test.ts web/src/components/AsrStatus.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/app.ts server/src/app.test.ts server/src/index.ts web/src/types.ts web/src/api.ts web/src/components/AsrStatus.tsx web/src/components/AsrStatus.test.tsx
git commit -m "feat(web): show the sidecar state and its log instead of pointing at a terminal"
```

---

## Task 10: 设置页启停文案按运行时分叉

**Files:**
- Modify: `web/src/pages/SettingsPage.tsx`、`web/src/pages/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `api.runtime()`
- Produces: 浏览器模式仍引 `STOP_HINT`；桌面模式不引、改说关窗口即退出与原生菜单。

- [ ] **Step 1: 写守卫测试（先红）**

在 `SettingsPage.test.tsx` 现有四条之外追加：

```ts
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
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run web/src/pages/SettingsPage.test.tsx`
Expected: FAIL（页面还没有 runtime 分支）

- [ ] **Step 3: 在页面里取 runtime 并分叉**

```tsx
// import type { RuntimeInfo } from '../types';
const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
useEffect(() => { api.runtime().then(setRuntime).catch(() => setRuntime(null)); }, []);
```

把「怎么开启 / 怎么关闭」那张卡的内容改成一个函数：

```tsx
const DESKTOP_HELP = (
  <Space direction="vertical" size={10} style={{ width: '100%' }}>
    <Typography.Text className="measure">
      <strong>关闭</strong>：关掉这个窗口就退出了，后台不会留进程。
    </Typography.Text>
    <Typography.Text className="measure">
      <strong>数据</strong>：菜单「文件 → 打开数据文件夹」能直接看到词条、练习记录、发音档案和本机笔记。
    </Typography.Text>
    <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
      要换一个数据文件夹：菜单「文件 → 更换数据文件夹…」，选完会重启。
    </Typography.Text>
  </Space>
);
// END DESKTOP_HELP

// ...在 JSX 里：
{runtime?.desktop ? DESKTOP_HELP : (
  /* 现有的浏览器那段原样留在这里，仍然引 STOP_HINT */
)}
```

- [ ] **Step 4: 跑全部设置页测试**

Run: `npx vitest run web/src/pages/SettingsPage.test.tsx`
Expected: PASS（旧四条仍绿；新一条绿）

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/SettingsPage.tsx web/src/pages/SettingsPage.test.tsx
git commit -m "fix(web): say how to quit the desktop app instead of quoting a terminal window"
```

---

## Task 11: 随包运行时下载脚本与桌面路径

**Files:**
- Create: `scripts/fetch-runtime.mjs`、`scripts/runtime-versions.json`、`desktop/src/paths.ts`、`desktop/src/paths.test.ts`
- Modify: `package.json`（`fetch-runtime` 已有）

**Interfaces:**
- Produces:
  - `resolveDesktopPaths(host, settings, env?): DesktopPaths`
  - `DesktopPaths`：`serverEntry` `nodePath` `uvPath` `appRoot` `dataDir` `shippedRoot` `webDist` `workflowsDir` `asrProjectDir` `logDir` `logFile`
  - `scripts/runtime-versions.json`：`{ node: { version, sha256 }, uv: { version, sha256 } }`

- [ ] **Step 1: 写路径测试**

```ts
// desktop/src/paths.test.ts
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolveDesktopPaths } from './paths.js';

const repo = resolve('/repo');
const userData = resolve('/appdata/zhengyin');

describe('桌面路径', () => {
  it('开发模式：用 PATH 上的 node/uv，资源与数据都在仓库', () => {
    const p = resolveDesktopPaths({ isPackaged: false, resourcesPath: '/nope', userData, repoRoot: repo }, {});
    expect(p.serverEntry).toBe(join(repo, 'server', 'dist', 'index.js'));
    expect(p.nodePath).toBe('node');
    expect(p.uvPath).toBe('uv');
    expect(p.appRoot).toBe(repo);
    expect(p.shippedRoot).toBe(repo);
    expect(p.logDir).toBe(join(userData, 'logs'));
  });

  it('打包模式：运行时与资源在 resources，数据在指定 appRoot', () => {
    const resources = resolve('/app/resources');
    const appRoot = resolve('/data/old-zhengyin');
    const p = resolveDesktopPaths(
      { isPackaged: true, resourcesPath: resources, userData, repoRoot: repo },
      { appRoot },
    );
    expect(p.serverEntry).toBe(join(resources, 'server', 'dist', 'index.js'));
    expect(p.nodePath).toBe(join(resources, 'runtime', 'node.exe'));
    expect(p.uvPath).toBe(join(resources, 'runtime', 'uv.exe'));
    expect(p.appRoot).toBe(appRoot);
    expect(p.shippedRoot).toBe(resources);
    expect(p.webDist).toBe(join(resources, 'web', 'dist'));
    expect(p.asrProjectDir).toBe(join(resources, 'asr-service'));
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run desktop/src/paths.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `desktop/src/paths.ts`**

```ts
import { join } from 'node:path';

export interface HostInfo {
  isPackaged: boolean; resourcesPath: string; userData: string; repoRoot: string;
}
export interface DesktopSettings { appRoot?: string }
export interface DesktopPaths {
  serverEntry: string; nodePath: string; uvPath: string;
  appRoot: string; dataDir: string; shippedRoot: string;
  webDist: string; workflowsDir: string; asrProjectDir: string;
  logDir: string; logFile: string;
}

export function resolveDesktopPaths(host: HostInfo, settings: DesktopSettings, env: NodeJS.ProcessEnv = process.env): DesktopPaths {
  const base = host.isPackaged ? host.resourcesPath : host.repoRoot;
  const appRoot = settings.appRoot ?? (host.isPackaged ? join(host.userData, 'app') : host.repoRoot);
  const shippedRoot = host.isPackaged ? host.resourcesPath : host.repoRoot;
  const logDir = join(host.userData, 'logs');
  return {
    serverEntry: join(base, 'server', 'dist', 'index.js'),
    nodePath: host.isPackaged ? join(host.resourcesPath, 'runtime', 'node.exe') : (env.NODE_BINARY || 'node'),
    uvPath: host.isPackaged ? join(host.resourcesPath, 'runtime', 'uv.exe') : (env.UV_PATH || 'uv'),
    appRoot,
    dataDir: join(appRoot, 'data'),
    shippedRoot,
    webDist: join(shippedRoot, 'web', 'dist'),
    workflowsDir: join(shippedRoot, 'workflows'),
    asrProjectDir: join(shippedRoot, 'asr-service'),
    logDir,
    logFile: join(logDir, 'server.log'),
  };
}
```

- [ ] **Step 4: 写下载脚本**

`scripts/runtime-versions.json` 先落结构（版本在下一步用 `--record` 写入）：

```json
{
  "node": { "version": "", "sha256": "" },
  "uv": { "version": "", "sha256": "" }
}
```

`scripts/fetch-runtime.mjs`：

```js
// 下载随包的 node.exe 与 uv.exe。版本与哈希在 scripts/runtime-versions.json。
// 第一次：node scripts/fetch-runtime.mjs --record（下载、打印并写回哈希）
// 之后：   node scripts/fetch-runtime.mjs（校验哈希，不匹配就失败）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const root = join(import.meta.dirname, '..');
const versionsFile = join(root, 'scripts', 'runtime-versions.json');
const vendor = join(root, 'desktop', 'vendor');
const cache = join(vendor, '.cache');
const record = process.argv.includes('--record');
const versions = JSON.parse(readFileSync(versionsFile, 'utf8'));

const NODE_URL = (v) => `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`;
const UV_URL = (v) => `https://github.com/astral-sh/uv/releases/download/${v}/uv-x86_64-pc-windows-msvc.zip`;

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}: ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function ensure(key, url, exe) {
  const cur = versions[key];
  if (!cur.version) throw new Error(`scripts/runtime-versions.json 里 ${key}.version 还是空的`);
  mkdirSync(cache, { recursive: true });
  const zipPath = join(cache, `${key}.zip`);
  const bytes = await fetchBytes(url(cur.version));
  const digest = sha256(bytes);
  if (!record && cur.sha256 && digest !== cur.sha256) {
    throw new Error(`${key} 的 SHA256 不匹配：期望 ${cur.sha256}，实际 ${digest}`);
  }
  if (record && !cur.sha256) cur.sha256 = digest;
  writeFileSync(zipPath, bytes);
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(`/${exe}`) || e.entryName === exe);
  if (!entry) throw new Error(`${key}.zip 里找不到 ${exe}`);
  copyFileSync(entry.entryName && zip.extractEntryTo(entry, vendor, false, true) ? join(vendor, entry.entryName.split('/').pop()) : '', join(vendor, exe));
  rmSync(zipPath, { force: true });
  return digest;
}

try {
  const nodeDigest = await ensure('node', NODE_URL, 'node.exe');
  const uvDigest = await ensure('uv', UV_URL, 'uv.exe');
  if (record) {
    versions.node.sha256 ||= nodeDigest;
    versions.uv.sha256 ||= uvDigest;
    writeFileSync(versionsFile, `${JSON.stringify(versions, null, 2)}\n`);
  }
  for (const f of ['node.exe', 'uv.exe']) {
    if (!existsSync(join(vendor, f))) throw new Error(`没有生成 ${f}`);
  }
  console.log(`runtime ok: node ${versions.node.version} / uv ${versions.uv.version}`);
} catch (e) {
  console.error(`[runtime] ${e.message}`);
  process.exit(1);
}
```

⚠ 上面 `extractEntryTo` 的写法在实现时要简化：`entry.getData()` 写文件更直接（`writeFileSync(join(vendor, exe), entry.getData())`）。计划里的表达只说明行为，落地照这个简化。

- [ ] **Step 5: 填版本、下载、校验、跑路径测试**

```bash
# 用本机 uv 的版本作为固定版本；Node 用与 CI 打包 job 相同的大版本（24.x）
uv --version
# 把输出里的版本填进 scripts/runtime-versions.json 的 uv.version；
# node.version 填 24.x 的当前版本（与 better-sqlite3 预编译包的 ABI 同大版本）
node scripts/fetch-runtime.mjs --record
node scripts/fetch-runtime.mjs
npx vitest run desktop/src/paths.test.ts
```

Expected: `runtime ok: node … / uv …`；路径测试 PASS。

- [ ] **Step 6: 提交**

```bash
git add scripts/fetch-runtime.mjs scripts/runtime-versions.json desktop/src/paths.ts desktop/src/paths.test.ts package-lock.json
git commit -m "feat(desktop): bundle the node and uv runtimes from pinned versions"
```

---

## Task 12: 桌面日志与服务子进程

**Files:**
- Create: `desktop/src/logs.ts`、`desktop/src/logs.test.ts`、`desktop/src/ports.ts`、`desktop/src/ports.test.ts`、`desktop/src/serverChild.ts`、`desktop/src/serverChild.test.ts`
- Modify: `desktop/src/paths.ts`（消费）

**Interfaces:**
- Produces:
  - `LogSink { write(chunk), tail(n), file }`
  - `pickFreePort(host?): Promise<number>`
  - `startServer({ paths, port, log, spawnFn?, fetchFn? }): Promise<ChildHandle | null>`
  - `waitUntilHealthy(port, opts?): Promise<boolean>`
  - `serverEnv(paths, port): NodeJS.ProcessEnv`

- [ ] **Step 1: 写测试**

```ts
// desktop/src/logs.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogSink } from './logs.js';

describe('LogSink', () => {
  it('落盘、保留尾部、超限滚动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const file = join(dir, 'server.log');
    const s = new LogSink(file, 200);
    s.write('a'.repeat(150));
    s.write('b'.repeat(150));
    expect(s.tail(2).join('')).toContain('b');
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
  });
});
```

```ts
// desktop/src/serverChild.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { serverEnv, startServer, waitUntilHealthy } from './serverChild.js';
import type { DesktopPaths } from './paths.js';

const paths: DesktopPaths = {
  serverEntry: 'C:/res/server/dist/index.js', nodePath: 'C:/res/runtime/node.exe',
  uvPath: 'C:/res/runtime/uv.exe', appRoot: 'C:/data', dataDir: 'C:/data/data',
  shippedRoot: 'C:/res', webDist: 'C:/res/web/dist', workflowsDir: 'C:/res/workflows',
  asrProjectDir: 'C:/res/asr-service', logDir: 'C:/logs', logFile: 'C:/logs/server.log',
};

describe('serverEnv', () => {
  it('把两个根、运行时与桌面标志都传下去，并清掉 ELECTRON_RUN_AS_NODE', () => {
    const env = serverEnv(paths, 30100, '1.0.0');
    expect(env.PORT).toBe('30100');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.APP_ROOT).toBe('C:/data');
    expect(env.SHIPPED_ROOT).toBe('C:/res');
    expect(env.WEB_DIST).toBe('C:/res/web/dist');
    expect(env.UV_PATH).toBe('C:/res/runtime/uv.exe');
    expect(env.ASR_AUTOSTART).toBe('1');
    expect(env.NO_OPEN).toBe('1');
    expect(env.APP_RUNTIME).toBe('desktop');
    expect(env.APP_VERSION).toBe('1.0.0');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

describe('waitUntilHealthy', () => {
  it('先探一次；通了就立刻返回；超时返回 false', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => ({ ok: ++calls > 1, json: async () => ({ ok: true }) }));
    expect(await waitUntilHealthy(1, { fetchFn: fetchFn as any, sleepFn: async () => {}, nowFn: () => 0, timeoutMs: 10 })).toBe(true);
    expect(await waitUntilHealthy(1, { fetchFn: vi.fn(async () => ({ ok: false, json: async () => ({ ok: false }) })) as any, sleepFn: async () => {}, nowFn: () => Date.now(), timeoutMs: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run desktop/src/logs.test.ts desktop/src/serverChild.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `logs.ts`、`ports.ts`、`serverChild.ts`**

`logs.ts`：环形缓冲 + 追加写；超过 `maxBytes` 把当前文件改名 `.1`（覆盖旧的）再重开；`tail(n)` 按行切最后 n 行。

`ports.ts`：与 `server/src/net.ts` 的 `pickFreePort` 同实现（桌面包不能 import server 源码，复制一份，两边都有测试）。

`serverChild.ts`：

```ts
import { spawn as spawnNode, type ChildProcess } from 'node:child_process';
import type { DesktopPaths } from './paths.js';
import { LogSink } from './logs.js';

export interface LaunchError { code?: string; syscall?: string; message: string }
export interface ChildHandle {
  stop(): Promise<void>;
  onExit(cb: (code: number | null, killedByUs: boolean, launchError: LaunchError | null) => void): void;
}

export function serverEnv(paths: DesktopPaths, port: number, version = ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1',
    APP_ROOT: paths.appRoot, SHIPPED_ROOT: paths.shippedRoot,
    DATA_DIR: paths.dataDir, WEB_DIST: paths.webDist,
    WORKFLOWS_DIR: paths.workflowsDir, ASR_PROJECT_DIR: paths.asrProjectDir,
    UV_PATH: paths.uvPath, ASR_AUTOSTART: '1', NO_OPEN: '1',
    APP_RUNTIME: 'desktop',
    APP_VERSION: version,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function describeLaunchFailure(e: LaunchError): string {
  if (e.code === 'ENOENT') return '找不到服务入口文件（安装目录可能不完整）';
  if (e.code === 'EACCES' || e.code === 'EPERM') return '系统拒绝创建这个进程（多半被安全软件拦了）';
  return e.message;
}

export async function waitUntilHealthy(port: number, opts: {
  fetchFn?: typeof fetch; sleepFn?: (ms: number) => Promise<void>; nowFn?: () => number;
  timeoutMs?: number; intervalMs?: number;
} = {}): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = opts.nowFn ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 300;
  const deadline = nowFn() + timeoutMs;
  for (;;) {
    try {
      const r = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok && (await r.json() as { ok?: unknown }).ok === true) return true;
    } catch { /* 继续等 */ }
    if (nowFn() >= deadline) return false;
    await sleepFn(intervalMs);
  }
}

export async function startServer(o: {
  paths: DesktopPaths; port: number; log: LogSink; version?: string;
  spawnFn?: typeof spawnNode; fetchFn?: typeof fetch;
}): Promise<ChildHandle> {
  const child = (o.spawnFn ?? spawnNode)(o.paths.nodePath, [o.paths.serverEntry], {
    env: serverEnv(o.paths, o.port, o.version), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout?.on('data', (b: Buffer) => o.log.write(b.toString()));
  child.stderr?.on('data', (b: Buffer) => o.log.write(b.toString()));

  let killedByUs = false;
  let exited: number | null | undefined;
  let launchError: LaunchError | null = null;
  let cb: ((code: number | null, killedByUs: boolean, launchError: LaunchError | null) => void) | undefined;
  const settle = (code: number | null, err?: NodeJS.ErrnoException) => {
    if (exited !== undefined) return;
    exited = code;
    launchError = err ? { code: err.code, syscall: err.syscall, message: err.message } : null;
    cb?.(code, killedByUs, launchError);
  };
  child.on('exit', (code) => settle(code));
  child.on('error', (err: NodeJS.ErrnoException) => settle(null, err));

  return {
    async stop() {
      if (killedByUs) return;
      killedByUs = true;
      child.kill();
      await new Promise<void>((r) => setTimeout(r, 1500));
      if (child.pid) {
        const { spawnSync } = await import('node:child_process');
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退 */ }
      }
    },
    onExit(f) { cb = f; if (exited !== undefined) f(exited, killedByUs, launchError); },
  };
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run desktop/src/logs.test.ts desktop/src/ports.test.ts desktop/src/serverChild.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add desktop/src/logs.ts desktop/src/logs.test.ts desktop/src/ports.ts desktop/src/ports.test.ts desktop/src/serverChild.ts desktop/src/serverChild.test.ts
git commit -m "feat(desktop): spawn the server on the bundled node and keep its log"
```

---

## Task 13: 桌面设置、首启选择、外链与权限

**Files:**
- Create: `desktop/src/settings.ts`、`desktop/src/settings.test.ts`、`desktop/src/firstRun.ts`、`desktop/src/firstRun.test.ts`、`desktop/src/links.ts`、`desktop/src/links.test.ts`、`desktop/src/permissions.ts`、`desktop/src/permissions.test.ts`

**Interfaces:**
- Produces:
  - `readDesktopSettings(file): DesktopSettings | null`、`writeDesktopSettings(file, s)`
  - `validateDataRoot(dir): string | null`
  - `askFirstRun(dialog): Promise<FirstRunChoice>`
  - `decideLink(raw, appOrigin): LinkDecision`
  - `decidePermission(permission): boolean`

- [ ] **Step 1: 写测试**

```ts
// desktop/src/firstRun.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDataRoot } from './firstRun.js';

describe('旧数据文件夹校验', () => {
  it('含 data/ 或 notes/ 才收', () => {
    const ok = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(ok, 'data'));
    expect(validateDataRoot(ok)).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    expect(validateDataRoot(empty)).toMatch(/不像正音/);
  });
});
```

```ts
// desktop/src/links.test.ts
import { describe, it, expect } from 'vitest';
import { decideLink } from './links.js';

describe('链接去向', () => {
  it('本应用地址留在窗口里', () => {
    expect(decideLink('http://127.0.0.1:30100/word/click', 'http://127.0.0.1:30100')).toEqual({ kind: 'stay' });
  });
  it('http/https 外链交给系统', () => {
    expect(decideLink('https://example.com/', 'http://127.0.0.1:30100')).toEqual({ kind: 'external', url: 'https://example.com/' });
  });
  it('file:、javascript:、相对路径一律拒绝', () => {
    for (const u of ['file:///C:/x', 'javascript:alert(1)', '/relative']) {
      expect(decideLink(u, 'http://127.0.0.1:30100')).toEqual({ kind: 'deny' });
    }
  });
});
```

```ts
// desktop/src/permissions.test.ts
import { expect, it } from 'vitest';
import { decidePermission } from './permissions.js';

it('只放麦克风', () => {
  expect(decidePermission('media')).toBe(true);
  expect(decidePermission('notifications')).toBe(false);
  expect(decidePermission('geolocation')).toBe(false);
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run desktop/src/firstRun.test.ts desktop/src/links.test.ts desktop/src/permissions.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现四个模块**

`settings.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DesktopSettings { schemaVersion: 1; appRoot: string }

export function readDesktopSettings(file: string): DesktopSettings | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopSettings>;
    if (raw.schemaVersion !== 1 || typeof raw.appRoot !== 'string' || !raw.appRoot.trim()) return null;
    return { schemaVersion: 1, appRoot: raw.appRoot };
  } catch {
    return null;
  }
}

export function writeDesktopSettings(file: string, s: DesktopSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw e;
  }
}
```

`settings.test.ts`：写入后读回、坏 JSON 回 null、缺字段回 null。

`firstRun.ts`：

```ts
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type FirstRunChoice =
  | { kind: 'fresh' } | { kind: 'existing'; dir: string } | { kind: 'backup'; file: string };

export function validateDataRoot(dir: string): string | null {
  try {
    if (!statSync(dir).isDirectory()) return '选中的不是一个文件夹。';
  } catch { return '这个文件夹读不到。'; }
  for (const marker of ['data', 'notes', '发音档案.template.md']) {
    if (existsSync(join(dir, marker))) return null;
  }
  return '这个文件夹不像正音的数据根（里面没有 data/、notes/ 或 发音档案.template.md）。';
}

export async function askFirstRun(dialog: {
  showMessageBox(opts: object): Promise<{ response: number }>;
  showOpenDialog(opts: object): Promise<{ canceled: boolean; filePaths: string[] }>;
}): Promise<FirstRunChoice> {
  const { response } = await dialog.showMessageBox({
    type: 'question', title: '正音', message: '要使用已有的正音数据吗？',
    detail: '可以选旧的「正音」文件夹（数据原样继续用），也可以导入备份文件，或者从空白开始。',
    buttons: ['选旧文件夹', '导入备份', '全新开始'], defaultId: 2, cancelId: 2,
  });
  if (response === 0) {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { kind: 'fresh' };
    const bad = validateDataRoot(r.filePaths[0]);
    if (bad) {
      await dialog.showMessageBox({ type: 'error', title: '这个文件夹用不了', message: bad });
      return askFirstRun(dialog);
    }
    return { kind: 'existing', dir: r.filePaths[0] };
  }
  if (response === 1) {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '备份', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { kind: 'fresh' };
    return { kind: 'backup', file: r.filePaths[0] };
  }
  return { kind: 'fresh' };
}
```

`links.ts`：

```ts
export type LinkDecision = { kind: 'stay' } | { kind: 'external'; url: string } | { kind: 'deny' };

export function decideLink(raw: string, appOrigin: string): LinkDecision {
  let u: URL;
  try { u = new URL(raw, appOrigin); } catch { return { kind: 'deny' }; }
  if (u.origin === appOrigin) return { kind: 'stay' };
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'external', url: u.href };
  return { kind: 'deny' };
}
```

`permissions.ts`：

```ts
export function decidePermission(permission: string): boolean {
  return permission === 'media';
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run desktop/src/settings.test.ts desktop/src/firstRun.test.ts desktop/src/links.test.ts desktop/src/permissions.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add desktop/src/settings.ts desktop/src/settings.test.ts desktop/src/firstRun.ts desktop/src/firstRun.test.ts desktop/src/links.ts desktop/src/links.test.ts desktop/src/permissions.ts desktop/src/permissions.test.ts
git commit -m "feat(desktop): pick a data root on first run and keep links out of the window"
```

---

## Task 14: 主进程、菜单与更新

**Files:**
- Create: `desktop/src/updater.ts`、`desktop/src/updater.test.ts`、`desktop/src/menu.ts`、`desktop/src/menu.test.ts`、`desktop/src/main.ts`
- Modify: `web/src/lib/desktopIdentity.test.ts`（加 AUMID 断言）

**Interfaces:**
- Consumes: 前面所有桌面模块
- Produces: 可运行的 `desktop/dist/main.js`

- [ ] **Step 1: 写更新与菜单测试**

```ts
// desktop/src/updater.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAutoCheck, saveAutoCheck, shouldEnableUpdater } from './updater.js';

it('自动检查默认关，写入后可读回', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'upd-')), 'update-prefs.json');
  expect(loadAutoCheck(file)).toBe(false);
  saveAutoCheck(file, true);
  expect(loadAutoCheck(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('true');
});

it('只有打包的 Windows NSIS 才接更新器', () => {
  expect(shouldEnableUpdater({ isPackaged: true, platform: 'win32', channel: 'nsis' })).toBe(true);
  expect(shouldEnableUpdater({ isPackaged: false, platform: 'win32', channel: 'nsis' })).toBe(false);
  expect(shouldEnableUpdater({ isPackaged: true, platform: 'win32', channel: 'zip' })).toBe(false);
  expect(shouldEnableUpdater({ isPackaged: true, platform: 'darwin', channel: 'nsis' })).toBe(false);
});
```

```ts
// desktop/src/menu.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildMenuTemplate } from './menu.js';

it('菜单里有打开数据文件夹、检查更新、退出', () => {
  const labels: string[] = [];
  const t = buildMenuTemplate({
    openDataFolder: vi.fn(), reload: vi.fn(), quit: vi.fn(), about: vi.fn(),
    updater: { check: vi.fn(), restart: vi.fn(), autoCheck: true, toggleAutoCheck: vi.fn(), readyVersion: null },
  });
  const walk = (items: any[]) => items.forEach((i) => { if (i.label) labels.push(i.label); if (i.submenu) walk(i.submenu); });
  walk(t);
  expect(labels).toEqual(expect.arrayContaining(['打开数据文件夹', '检查更新', '退出']));
});
```

- [ ] **Step 2: 跑它，确认红**

Run: `npx vitest run desktop/src/updater.test.ts desktop/src/menu.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `updater.ts` 与 `menu.ts`**

`updater.ts` 的纯逻辑：

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type UpdateChannel = 'nsis' | 'zip';

export function updateChannelFromPackage(pkg: { zhengyinChannel?: string }): UpdateChannel {
  return pkg.zhengyinChannel === 'zip' ? 'zip' : 'nsis';
}

export function shouldEnableUpdater(o: { isPackaged: boolean; platform: string; channel: UpdateChannel }): boolean {
  return o.isPackaged && o.platform === 'win32' && o.channel === 'nsis';
}

export function loadAutoCheck(file: string): boolean {
  if (!existsSync(file)) return false;
  try { return JSON.parse(readFileSync(file, 'utf8')).autoCheck === true; } catch { return false; }
}

export function saveAutoCheck(file: string, value: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ autoCheck: value }), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 不掩盖原始错误 */ }
    throw e;
  }
}
```

`createUpdater(autoUpdater, hooks)` 只做接线（照 035 的结构，去掉托盘）：把 `checking-for-update` / `update-available` / `update-downloaded` / `error` 转成 `onChange()` 与 `balloon(title, content)`；提供 `state()`、`checkManual()`、`setAutoCheck(v)`、`scheduleAuto()`、`versionReady()`、`restartToInstall()`。`autoUpdater.autoDownload = true`、`autoInstallOnAppQuit = false` 在 `main.ts` 里设。

`menu.ts`：

```ts
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuOps {
  openDataFolder: () => void;
  reload: () => void;
  quit: () => void;
  about: () => void;
  devTools?: (() => void) | null;
  updater: {
    check: () => void; restart: () => void; autoCheck: boolean;
    toggleAutoCheck: (v: boolean) => void; readyVersion: string | null;
  } | null;
}

export function buildMenuTemplate(o: MenuOps): MenuItemConstructorOptions[] {
  const file: MenuItemConstructorOptions[] = [
    { label: '打开数据文件夹', click: o.openDataFolder },
    { label: '重新加载', click: o.reload },
    { type: 'separator' },
    { label: '退出', click: o.quit },
  ];
  const help: MenuItemConstructorOptions[] = [];
  if (o.updater) {
    help.push(
      { label: '检查更新', click: o.updater.check },
      { label: '自动检查更新', type: 'checkbox', checked: o.updater.autoCheck, click: (i) => o.updater?.toggleAutoCheck(i.checked) },
    );
    if (o.updater.readyVersion) help.push({ label: `重启以完成更新 v${o.updater.readyVersion}`, click: o.updater.restart });
    help.push({ type: 'separator' });
  }
  help.push({ label: '关于正音', click: o.about });
  if (o.devTools) help.push({ type: 'separator' }, { label: '开发者工具', click: o.devTools });
  return [
    { label: '文件', submenu: file },
    { label: '帮助', submenu: help },
  ];
}
```

- [ ] **Step 4: 写 `main.ts`**

按下面的顺序与要点写全（文件较长，照这个骨架落地，不要留空白实现）：

```ts
import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDesktopPaths } from './paths.js';
import { readDesktopSettings, writeDesktopSettings } from './settings.js';
import { askFirstRun } from './firstRun.js';
import { decideLink } from './links.js';
import { decidePermission } from './permissions.js';
import { LogSink } from './logs.js';
import { pickFreePort } from './ports.js';
import { startServer, waitUntilHealthy, describeLaunchFailure, type ChildHandle } from './serverChild.js';
import { buildMenuTemplate } from './menu.js';
import { loadAutoCheck, saveAutoCheck, shouldEnableUpdater, updateChannelFromPackage, createUpdater } from './updater.js';

const USER_DATA = join(app.getPath('appData'), 'zhengyin');
mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);
app.setAppUserModelId('com.rockbenben.zhengyin');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const prefsFile = join(USER_DATA, 'update-prefs.json');
const settingsFile = join(USER_DATA, 'desktop-settings.json');
const ICON = join(here, '..', 'build', 'icon.png');

let win: BrowserWindow | null = null;
let child: ChildHandle | null = null;
let quitting = false;
let updater: ReturnType<typeof createUpdater> | null = null;
let port = 0;

function pkg() {
  return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string; zhengyinChannel?: string };
}

function openWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createWindow(healthy: boolean): void {
  win = new BrowserWindow({
    width: 1200, height: 800, icon: ICON, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win?.show());
  const origin = `http://127.0.0.1:${port}`;
  const handOff = (raw: string) => {
    const d = decideLink(raw, origin);
    if (d.kind === 'external') void shell.openExternal(d.url).catch(() => undefined);
  };
  win.webContents.setWindowOpenHandler(({ url }) => { handOff(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (decideLink(url, origin).kind === 'stay') return;
    e.preventDefault(); handOff(url);
  });
  win.on('closed', () => { win = null; });
  const target = healthy
    ? origin
    : `data:text/html;charset=utf-8,${encodeURIComponent(`<meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;line-height:1.7"><h1>正音没能启动后台服务</h1><p>日志在：<code>${join(USER_DATA, 'logs', 'server.log')}</code></p><p>把它发出来就能定位。修好之后重新打开正音。</p></body>`)}`;
  void win.loadURL(target);
}

function installPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(decidePermission(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => decidePermission(permission));
}

function buildMenu(): void {
  const versionReady = updater?.versionReady() ?? null;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    openDataFolder: () => void shell.openPath(USER_DATA),
    reload: () => win?.reload(),
    quit: () => app.quit(),
    about: () => void dialog.showMessageBox({ type: 'info', title: '关于正音', message: `正音 ${app.getVersion()}`, detail: '美式发音逐音素评测与笔记。数据全部在这台机器上。' }),
    updater: updater ? {
      check: () => updater?.checkManual(),
      restart: () => updater?.restartToInstall(),
      autoCheck: loadAutoCheck(prefsFile),
      toggleAutoCheck: (v: boolean) => { saveAutoCheck(prefsFile, v); updater?.setAutoCheck(v); buildMenu(); },
      readyVersion,
    } : null,
    devTools: app.isPackaged ? null : () => win?.webContents.openDevTools(),
  })));
}

async function bootstrap(): Promise<void> {
  let settings = readDesktopSettings(settingsFile);
  let backupFile: string | null = null;
  if (!settings) {
    const choice = await askFirstRun(dialog);
    if (choice.kind === 'existing') settings = { schemaVersion: 1, appRoot: choice.dir };
    else if (choice.kind === 'backup') { settings = { schemaVersion: 1, appRoot: join(USER_DATA, 'app') }; backupFile = choice.file; }
    else settings = { schemaVersion: 1, appRoot: join(USER_DATA, 'app') };
    writeDesktopSettings(settingsFile, settings);
  }

  const paths = resolveDesktopPaths(
    { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, userData: USER_DATA, repoRoot },
    { appRoot: settings.appRoot },
  );
  mkdirSync(paths.logDir, { recursive: true });
  const log = new LogSink(paths.logFile, 2 * 1024 * 1024);
  port = await pickFreePort();

  try {
    child = await startServer({ paths, port, log, version: app.getVersion() });
    child.onExit((code, killedByUs, launchError) => {
      if (killedByUs) return;
      const why = launchError ? describeLaunchFailure(launchError) : `退出码 ${code ?? '未知'}`;
      void dialog.showMessageBox({ type: 'error', title: '正音的后台服务退出了', message: why, detail: `日志：${paths.logFile}` });
    });
    const healthy = await waitUntilHealthy(port);
    installPermissions();
    createWindow(healthy);

    if (backupFile && healthy) {
      const body = readFileSync(backupFile, 'utf8');
      const res = await fetch(`http://127.0.0.1:${port}/api/backup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!res.ok) {
        await dialog.showMessageBox({ type: 'warning', title: '备份没有导入成功', message: `服务返回 ${res.status}`, detail: '打开应用后可以在「设置 → 搬家」里再试一次。' });
      }
    }

    const channel = updateChannelFromPackage(pkg());
    if (shouldEnableUpdater({ isPackaged: app.isPackaged, platform: process.platform, channel })) {
      const { autoUpdater } = electronUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      updater = createUpdater(autoUpdater, {
        log: (m) => log.write(`[updater] ${m}\n`),
        balloon: (title, content) => { if (win) void dialog.showMessageBox({ type: 'info', title, message: content }); },
        showError: (m) => void dialog.showMessageBox({ type: 'error', title: '正音更新', message: m }),
        setTimer: (cb, ms) => { setTimeout(cb, ms); },
        readAutoCheck: () => loadAutoCheck(prefsFile),
        writeAutoCheck: (v) => saveAutoCheck(prefsFile, v),
        onChange: () => buildMenu(),
      });
      updater.scheduleAuto();
    }
    buildMenu();
  } catch (e) {
    await dialog.showMessageBox({ type: 'error', title: '正音启动失败', message: (e as Error).message, detail: `日志：${paths.logFile}` });
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => openWindow());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void (child?.stop() ?? Promise.resolve()).finally(() => app.quit());
  });
  void app.whenReady().then(bootstrap);
}
```

要点：

- `app.setPath('userData')` 在所有 `getPath('userData')` 之前。
- `app.setAppUserModelId('com.rockbenben.zhengyin')` 与 builder 的 appId 一字不差。
- 关窗口 = 退出（`window-all-closed` → `app.quit()`），不建托盘。
- 更新器只在 NSIS（`zhengyinChannel !== 'zip'`）。
- 服务起不来时窗口加载一句人话 + 日志路径，不留白屏。

- [ ] **Step 5: 类型检查与身份守卫**

在 `web/src/lib/desktopIdentity.test.ts` 追加：

```ts
it('主进程的 AUMID 与 builder 的 appId 一致', () => {
  const main = read('desktop/src/main.ts');
  expect(main).toContain("com.rockbenben.zhengyin");
  const cfg = read('desktop/electron-builder.config.mjs');
  expect(cfg).toContain("appId: 'com.rockbenben.zhengyin'");
});
```

Run: `npm run typecheck && npx vitest run desktop/src web/src/lib/desktopIdentity.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add desktop/src/main.ts desktop/src/menu.ts desktop/src/menu.test.ts desktop/src/updater.ts desktop/src/updater.test.ts web/src/lib/desktopIdentity.test.ts
git commit -m "feat(desktop): open the app, keep links out, and update only the NSIS build"
```

---

## Task 15: CSP、打包配置、清单守卫与打包冒烟

**Files:**
- Create: `server/src/csp.ts`、`server/src/csp.test.ts`、`scripts/server-runtime-deps.mjs`、`desktop/electron-builder.config.mjs`、`desktop/electron-builder-zip.config.mjs`、`scripts/check-package.mjs`、`scripts/smoke-package.mjs`、`workflows/README.md`
- Modify: `server/src/index.ts`、`package.json`

**Interfaces:**
- Produces: `CSP` 常量；`serverRuntimeDeps(root)` / `serverRuntimeResources(root)`；`npm run check:package`；`npm run smoke:package`

- [ ] **Step 1: 写 CSP 测试**

```ts
// server/src/csp.test.ts
import { expect, it } from 'vitest';
import { CSP } from './csp.js';

it('CSP 允许 antd 的内联样式、录音 blob、vosk 的 wasm worker，同时关掉外部脚本', () => {
  expect(CSP).toContain("default-src 'self'");
  expect(CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(CSP).toContain("style-src 'self' 'unsafe-inline'");
  expect(CSP).toContain("media-src 'self' blob:");
  expect(CSP).toContain("worker-src 'self' blob:");
  expect(CSP).toContain("object-src 'none'");
});
```

- [ ] **Step 2: 实现 CSP 并在生产壳上加头**

```ts
// server/src/csp.ts
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');
```

`index.ts` 的 `shell()` 响应头加 `'Content-Security-Policy': CSP`。只在托管 `web/dist` 的生产段落加；开发模式不经过它。

- [ ] **Step 3: 写服务端依赖闭包与两份 builder 配置**

```js
// scripts/server-runtime-deps.mjs
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
  const found = new Map();
  const walk = (name, from) => {
    const dir = resolvePackageDir(name, from);
    if (!dir) throw new Error(`找不到运行时依赖 ${name}（从 ${from} 找起）`);
    const prev = found.get(name);
    if (prev && prev !== dir) throw new Error(`依赖 ${name} 有两份：${prev} 与 ${dir}`);
    if (prev) return;
    found.set(name, dir);
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
  // 用 walk 时记录的真实目录，别从 server/ 重新找——嵌套安装的包会找错
  return [...collect(root).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, dir]) => ({ from: relative(root, dir), to: join('server', 'node_modules', name) }));
}
```

```js
// desktop/electron-builder.config.mjs
import { serverRuntimeResources } from '../scripts/server-runtime-deps.mjs';

const root = process.cwd();
const base = {
  appId: 'com.rockbenben.zhengyin',
  productName: '正音',
  copyright: '个人使用',
  directories: { app: 'desktop', output: 'desktop/release', buildResources: 'desktop/build' },
  files: ['dist/**/*', 'build/icon.png', 'package.json'],
  asar: true,
  npmRebuild: false,
  extraMetadata: { zhengyinChannel: 'nsis' },
  publish: { provider: 'github', owner: 'rockbenben', repo: 'zhengyin' },
  extraResources: [
    { from: 'server/dist', to: 'server/dist' },
    { from: 'web/dist', to: 'web/dist' },
    { from: 'notes', to: 'notes' },
    { from: 'workflows', to: 'workflows' },
    { from: 'asr-service', to: 'asr-service', filter: ['main.py', 'pyproject.toml', 'uv.lock', '.python-version'] },
    { from: '发音档案.template.md', to: '发音档案.template.md' },
    { from: 'scripts/vosk-models.json', to: 'scripts/vosk-models.json' },
    { from: 'desktop/vendor/node.exe', to: 'runtime/node.exe' },
    { from: 'desktop/vendor/uv.exe', to: 'runtime/uv.exe' },
    { from: 'desktop/vendor/LICENSE-node.txt', to: 'runtime/LICENSE-node.txt' },
    { from: 'desktop/vendor/LICENSE-uv.txt', to: 'runtime/LICENSE-uv.txt' },
    ...serverRuntimeResources(root),
  ],
  win: { artifactName: 'zhengyin-${version}-win.${ext}', target: [{ target: 'nsis' }] },
  nsis: {
    artifactName: 'zhengyin-${version}-win-setup.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};
export default base;
```

```js
// desktop/electron-builder-zip.config.mjs
import base from './electron-builder.config.mjs';
export default {
  ...base,
  directories: { ...base.directories, output: 'desktop/release-zip' },
  extraMetadata: { ...base.extraMetadata, zhengyinChannel: 'zip' },
  // 不产 latest.yml：更新元数据只能有 NSIS 那一条，zip 不能覆盖它
  publish: null,
  win: { ...base.win, target: [{ target: 'zip' }] },
  nsis: undefined,
};
```

`workflows/README.md` 先放一句说明（真正的提示词在计划二）：

```md
# workflows

这里放 AI 的提示词正本。桌面化这一版先把目录和打包路径立起来，文件在 AI 接入时补。
```

同时在 `scripts/fetch-runtime.mjs` 里补许可证：node 的 zip 内 `LICENSE` 写成
`desktop/vendor/LICENSE-node.txt`；uv 的两份许可证从它仓库的 `LICENSE-MIT` 与
`LICENSE-APACHE` 取回，拼成 `desktop/vendor/LICENSE-uv.txt`。

- [ ] **Step 4: 写清单守卫 `scripts/check-package.mjs`**

```js
// 校验「打包会带上的东西」与「编译产物真正会 require 的东西」是同一份。
// 跑之前先 npm run build。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serverRuntimeDeps } from './server-runtime-deps.mjs';

const root = process.cwd();
const fail = (msg) => { console.error(`[check-package] ${msg}`); process.exit(1); };

const dist = join(root, 'server', 'dist');
if (!existsSync(dist)) fail('server/dist 不存在——先跑 npm run build');

const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const packageName = (spec) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

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
  'web/dist/index.html', 'notes', 'workflows', 'asr-service/main.py',
  'asr-service/pyproject.toml', 'asr-service/uv.lock', 'asr-service/.python-version',
  '发音档案.template.md', 'scripts/vosk-models.json',
  'desktop/vendor/node.exe', 'desktop/vendor/uv.exe',
  'desktop/vendor/LICENSE-node.txt', 'desktop/vendor/LICENSE-uv.txt',
]) {
  if (!existsSync(join(root, p))) fail(`缺 ${p}`);
}
if (!existsSync(join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))) {
  fail('better_sqlite3.node 不在——打包后服务会起不来');
}
const hash = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');
if (hash('desktop/build/icon.png') !== hash('web/public/icon-512.png')) fail('桌面图标与 PWA 图标不一致');

// 编译产物里不该出现"裸的 asar 路径"这类只在仓库里成立的写法
const bad = [];
for (const file of walk(dist).filter((f) => f.endsWith('.js'))) {
  const text = readFileSync(file, 'utf8');
  if (/from\s+['"]\/src\//.test(text)) bad.push(relative(root, file));
}
if (bad.length) fail(`这些文件里有绝对源码路径：${bad.join('、')}`);

console.log(`[check-package] ok：${imports.size} 个裸 import、${deps.size} 个运行时依赖`);
```

- [ ] **Step 5: 写打包冒烟 `scripts/smoke-package.mjs`**

把仓库外的一份 `<tmp>/res` 摆成打包后的布局，用随包 `node.exe` 真起一次服务：

```js
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serverRuntimeResources } from './server-runtime-deps.mjs';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'zhengyin-smoke-'));
const res = join(tmp, 'res');
const app = join(tmp, 'app');
mkdirSync(join(res, 'server'), { recursive: true });
mkdirSync(app, { recursive: true });
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
cpSync(join(root, 'desktop', 'vendor', 'uv.exe'), join(res, 'runtime', 'uv.exe'));

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port; s.close(() => resolve(p));
  });
  s.on('error', reject);
});
const child = spawn(join(res, 'runtime', 'node.exe'), [join(res, 'server', 'dist', 'index.js')], {
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    SHIPPED_ROOT: res, APP_ROOT: app, DATA_DIR: join(app, 'data'),
    WEB_DIST: join(res, 'web', 'dist'), WORKFLOWS_DIR: join(res, 'workflows'),
    ASR_PROJECT_DIR: join(res, 'asr-service'), UV_PATH: join(res, 'runtime', 'uv.exe'),
    ASR_AUTOSTART: '0', NO_OPEN: '1', APP_RUNTIME: 'desktop', APP_VERSION: '1.0.0',
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
  console.error(`[smoke-package] ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
  if (process.platform === 'win32' && child.pid) {
    const { spawnSync } = await import('node:child_process');
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  rmSync(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 6: 构建、打包、守卫、冒烟**

```bash
npm run build
npm run fetch-runtime
npm run check:package
npm run smoke:package
npm run dist:desktop
```

Expected: 四条全过；`desktop/release/` 下出现 `zhengyin-1.0.0-win-setup.exe` 与 `latest.yml`。

- [ ] **Step 7: 提交**

```bash
git add server/src/csp.ts server/src/csp.test.ts server/src/index.ts scripts/server-runtime-deps.mjs scripts/check-package.mjs scripts/smoke-package.mjs scripts/fetch-runtime.mjs desktop/electron-builder.config.mjs desktop/electron-builder-zip.config.mjs workflows/README.md
git commit -m "build(desktop): derive the packaged server deps and prove the layout starts"
```

---

## Task 16: CI、发布流水线与桌面策略

**Files:**
- Modify: `.github/workflows/ci.yml`、`.desktop-policy.json`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `npm test`、`npm run build`、`npm run fetch-runtime`、`npm run dist:desktop`、`npm run dist:desktop:zip`、`npm run check:package`、`npm run smoke:package`
- Produces: tag `vX.Y.Z` → 一个 NSIS 安装包 + 一个 zip + `latest.yml`，经人工审批后发布

- [ ] **Step 1: 给现有 CI 加两条 job**

在 `.github/workflows/ci.yml` 的 `jobs:` 下追加（保留原有 matrix 不动）：

```yaml
  asr-lock:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v7
      - name: 只装 uv，不下模型
        run: python -m pip install uv
      - run: uv lock --check --project asr-service

  desktop-package:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx install-electron
      - run: npm run build
      - run: npm run fetch-runtime
      - run: npm run check:package
      - run: npm run smoke:package
      - run: npm run dist:desktop
      - run: npm run dist:desktop:zip
      - uses: actions/upload-artifact@v7
        with:
          name: desktop-package
          if-no-files-found: error
          path: |
            desktop/release/*.exe
            desktop/release/latest.yml
            desktop/release/*.blockmap
            desktop/release-zip/*.zip
```

- [ ] **Step 2: 写 release workflow（Windows only，单一 publish）**

```yaml
# tag 是唯一版本源：tag == 根 package.json == desktop/package.json。
# validate → Windows 打包 → 单一 publish（校验 feed、SHA256、attest、人工审批、匿名核验）。
name: release
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      tag: { description: 'Existing tag to rebuild, e.g. v1.1.0', required: true }
permissions:
  contents: read
concurrency:
  group: release-${{ inputs.tag || github.ref_name }}
  cancel-in-progress: false
env:
  TAG: ${{ inputs.tag || github.ref_name }}

jobs:
  validate:
    runs-on: ubuntu-22.04
    outputs:
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v7
        with: { ref: '${{ env.TAG }}' }
      - id: version
        name: tag 与两份 package.json 对账
        shell: bash
        run: |
          [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::$TAG 不是 vX.Y.Z"; exit 1; }
          v="${TAG#v}"
          root=$(node -p "require('./package.json').version")
          desk=$(node -p "require('./desktop/package.json').version")
          [ "$root" = "$v" ] || { echo "::error::root package.json $root != $v"; exit 1; }
          [ "$desk" = "$v" ] || { echo "::error::desktop/package.json $desk != $v"; exit 1; }
          echo "version=$v" >> "$GITHUB_OUTPUT"
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: python -m pip install uv
      - run: uv lock --check --project asr-service
      - run: npm test

  build:
    needs: validate
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v7
        with: { ref: '${{ env.TAG }}' }
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npx install-electron
      - run: npm run build
      - run: npm run fetch-runtime
      - run: npm run check:package
      - run: npm run dist:desktop
      - run: npm run dist:desktop:zip
      - uses: actions/upload-artifact@v7
        with:
          name: dist-win
          if-no-files-found: error
          path: |
            desktop/release/*.exe
            desktop/release/latest.yml
            desktop/release/*.blockmap
            desktop/release-zip/*.zip

  publish:
    needs: [validate, build]
    runs-on: ubuntu-latest
    environment: release
    permissions:
      contents: write
      id-token: write
      attestations: write
      artifact-metadata: write
    env:
      GH_TOKEN: ${{ github.token }}
      REPO: ${{ github.repository }}
      VERSION: ${{ needs.validate.outputs.version }}
    steps:
      - uses: actions/download-artifact@v8
        with: { pattern: 'dist-*', merge-multiple: true, path: dist }
      - name: 校验 latest.yml 与它指向的文件
        run: |
          cd dist
          [ -f latest.yml ] || { echo "::error::缺 latest.yml"; exit 1; }
          grep -q "^version: $VERSION$" latest.yml || { echo "::error::latest.yml 版本不对"; exit 1; }
          while read -r u; do
            [ -f "$u" ] || { echo "::error::latest.yml 指向不存在的 $u"; exit 1; }
          done < <(grep -E '^\s*-?\s*url:' latest.yml | awk '{print $NF}')
      - name: SHA256SUMS（LF）
        run: cd dist && sha256sum -- * > SHA256SUMS && cat SHA256SUMS
      - uses: actions/attest@v4
        with: { subject-checksums: dist/SHA256SUMS }
      - name: 建/复用草稿并上传
        run: |
          if gh release view "$TAG" -R "$REPO" --json isDraft --jq .isDraft 2>/dev/null | grep -q false; then
            echo "::error::$TAG 已经发布过了，改版本号"; exit 1
          fi
          gh release view "$TAG" -R "$REPO" >/dev/null 2>&1 || \
            gh release create "$TAG" -R "$REPO" --draft --verify-tag --title "$TAG" --notes "见 CHANGELOG.md"
          gh release upload "$TAG" -R "$REPO" dist/* --clobber
      - name: 发布并设 latest
        run: |
          id=$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name==\"$TAG\" and .draft) | .id")
          gh api -X PATCH "repos/$REPO/releases/$id" -F draft=false -f make_latest=true >/dev/null
      - name: 匿名核验（像真实用户）
        run: |
          [ "$(gh api "repos/$REPO/releases/latest" --jq .tag_name)" = "$TAG" ] || { echo "::error::releases/latest 不是 $TAG"; exit 1; }
          ok=
          for _ in $(seq 1 10); do
            curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.yml" | grep -q "^version: $VERSION$" && { ok=1; break; }
            sleep 60
          done
          [ -n "$ok" ] || { echo "::error::公开的 latest.yml 十分钟后仍不是 $VERSION"; exit 1; }
```

发布前要在仓库 Settings → Environments 建 `release` 环境并加 required reviewer。没有审批人时流水线仍然只有一个 publish job，但人工门禁不存在。

- [ ] **Step 3: 把 `.desktop-policy.json` 补成终稿**

```json
{
  "schemaVersion": 2,
  "status": "project-deviations",
  "verifiedOn": "2026-10-27",
  "framework": "electron",
  "channel": "stable",
  "platforms": ["windows-x64"],
  "packageManager": "npm (npm ci in CI; package-lock.json is the source of truth)",
  "node": "24 for desktop builds; server floor 20.19.0 (CI matrix 20.19/22/24)",
  "distribution": {
    "primary": "github-releases",
    "windows": "nsis (updatable) + zip (manual update)"
  },
  "updater": "electron-updater on NSIS only; the zip build never initializes it",
  "signing": {
    "windows": "unsigned; SmartScreen warning documented in README"
  },
  "versionSource": "git tag vX.Y.Z; root and desktop/package.json asserted equal",
  "release": "validate (tests + uv lock) -> Windows build -> single draft -> verify feed -> SHA256SUMS + attestation -> release environment approval -> publish + make_latest -> anonymous feed check",
  "actionPins": "major tags; no Dependabot",
  "immutableReleases": "not enabled yet",
  "deviations": [
    {
      "rule": "platforms",
      "value": ["windows-x64"],
      "reason": "the phoneme sidecar needs Python and a 1.2GB model; no macOS/Linux hardware to verify the packaged sidecar",
      "revisitWhen": "first macOS/Linux user report, or 2027-06-30"
    },
    {
      "rule": "windows-unsigned",
      "reason": "personal project without a code-signing certificate; README documents the SmartScreen step",
      "revisitWhen": "wider public distribution or Azure Artifact Signing becomes available"
    },
    {
      "rule": "zip-no-updater",
      "reason": "the zip has no install root to replace; updater metadata is produced only by the NSIS build",
      "revisitWhen": "a portable update path is implemented and verified on a real machine"
    }
  ]
}
```

- [ ] **Step 4: 本地演练（不推 tag）**

```bash
npm test
npm run build
npm run fetch-runtime
npm run check:package
npm run smoke:package
```

Expected: 全过。release 流水线本身只能在推送 tag 后验证，这一步不要打 tag。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml .desktop-policy.json
git commit -m "ci(desktop): build and publish the Windows desktop package from a tag"
```

---

## Task 17: 文档、冒烟清单与最终验证

**Files:**
- Modify: `AGENTS.md`、`README.md`、`停止.cmd`、`停止.command`、`停止.sh`、`.env.example`
- Create: `desktop/冒烟清单.md`

**Interfaces:**
- Consumes: 前面全部
- Produces: 与代码同批的文档；一份只能在真机上走的清单

- [ ] **Step 1: 改 `AGENTS.md` 里会变假的句子**

逐条改，不要只加一段新的：

1. `npm start —— 只起服务（要先 npm run build）` → 补一句「服务会自己拉起识别服务；关掉服务会连带停掉它」。
2. `npm run asr` 那段里「边车是 concurrently 拉起的兄弟进程」与「npm start / npm run go 都会带上它」→ 改成：`npm start` 由服务拉起；`npm run dev` 仍单独跑（`ASR_AUTOSTART=0`），免得 tsx watch 每次重启都重载模型。
3. 「刻意没有做成网页上点一下关服务」那段：删掉「关不掉识别服务」这条理由（现在服务会带走边车），并补上默认只绑 `127.0.0.1` 之后局域网访问不再可用。
4. 文件布局表加三行：`desktop/`（Electron 外壳与打包配置）、`workflows/`（AI 提示词正本，计划二补）、`data/notes/`（本机笔记，AI 写这里；随附 `notes/` 只读）。
5. 「跟着发布走 / 本机数据 / 工具状态」三类：`desktop/` 跟发布走；`desktop/vendor/`、`desktop/release*/` 是构建产物；`data/notes` 跟 `data/` 一样是本机数据。
6. 端口一节：30032 不再写死，ASR 端口由服务挑；`ASR_PORT` 可固定。
7. Node 版本一节补：桌面版随包 `node.exe`，打包时 `better_sqlite3.node` 必须由同大版本 Node 安装；`nodeFloor.test.ts` 刻意不扫 `desktop/package.json`（Electron 自带 Node，桌面版不跑在用户的 Node 上）。
8. 常用命令加 `npm run desktop`、`npm run dist:desktop`、`npm run fetch-runtime`、`npm run check:package`、`npm run smoke:package`。

- [ ] **Step 2: 改 `README.md`**

新增「桌面版」一节（放在「怎么打开」之后），写清：

- 从 GitHub Releases 下载 `zhengyin-<版本>-win-setup.exe`（安装版，能自动更新）或 `-win.zip`（免安装，手动更新）。
- 未签名 → SmartScreen 的「更多信息 → 仍要运行」。
- 第一次打开会问：用旧的正音文件夹、导入备份、或全新开始；旧文件夹是**直接使用**，不复制。
- 数据在 `%APPDATA%\zhengyin\app`（选了旧文件夹则在那个文件夹里）；菜单「文件 → 打开数据文件夹」。
- 第一次做逐音素评测要下约 1.2GB 模型，界面里能看到日志。
- 关窗口就是退出；没有托盘。

把「怎么打开」那张表里的局域网一行改成：**只在本机用**。桌面版与浏览器模式都只绑 `127.0.0.1`；局域网 IP 不再能打开。理由不是安全洁癖——浏览器在非本机地址本来就不给麦克风。

在「关掉它」一节补一句：桌面版关窗口即退出；双击启动器那套仍然适用于浏览器模式。

- [ ] **Step 3: 改停止脚本的注释与 `.env.example`**

- `停止.cmd`：只改 ASCII 注释（这个文件必须保持纯 ASCII + CRLF）。把「concurrently -> node / uv -> python」改成「server -> asr (uv -> python)」；保留 `for %%P in (30031 30032)`，并在注释里说明 30032 只覆盖开发模式那种独立边车，桌面版/自托管边车会跟着服务进程树一起被杀。
- `停止.command` / `停止.sh`：同上，中文注释里去掉「concurrently 不会杀边车」的旧说法。
- `.env.example` 追加：

```dotenv
# 服务只绑本机。要让局域网访问才改成 0.0.0.0（浏览器在非本机地址不给麦克风）。
HOST=127.0.0.1
# 固定识别服务端口；不写就由服务挑空闲端口。
# ASR_PORT=30032
# 设为 0 时服务不托管识别服务（开发模式用）。
# ASR_AUTOSTART=1
```

- [ ] **Step 4: 写 `desktop/冒烟清单.md`**

必须覆盖这些条（每条写「怎么做 / 该看到什么」）：

1. 全新首次启动：窗口出来、不是白屏；建 click、录音、评测出结果；关掉重开数据还在。
2. 首启选旧文件夹：旧词条、旧笔记、发音档案都在；不复制、不移动。
3. 首启导入备份：词条/录音判定/复习进度回来；界面明确说「档案与笔记不在备份里」。
4. 首启选一个空文件夹：明确拒绝，让重选，不进主窗口。
5. 关窗口：进程树真的没了（任务管理器里没有 node.exe / uv.exe / python.exe 的子进程）；重开正常。
6. 识别服务首次准备：AsrStatus 显示 starting、日志能看到「开始获取」与进度；变成 ready 后录音能出逐音素结果。
7. 识别服务出错：把 uv 改名或断网，界面显示 error + 日志 + 重启按钮；重启能恢复；其他功能照常。
8. 麦克风：真录一次，波形/计时/自动评测都正常；拒绝权限时给的是能照做的中文，不是空白。
9. 数据锁：仓库里先 `npm start`，桌面版选同一个文件夹 → 说清被谁占着，让重选；关掉 `npm start` 后能进。
10. 单实例：再双击一次 → 只把已有窗口拉到前台，不出现第二个服务。
11. 外链：笔记正文或 AI 之前的链接（现在还没有 AI，用一个外链笔记测）→ 系统浏览器打开，应用本身没被导航走，也没弹第二个窗口。
12. 菜单：打开数据文件夹真的打开；检查更新在 NSIS 版有、zip 版没有；自动检查默认关。
13. SmartScreen：未签名安装包第一次双击的提示与打开方式。
14. 升级：装 vN，再装 vN+1，数据保留（自动更新只对 NSIS 版验证）。

- [ ] **Step 5: 最终验证**

```bash
npm test
npm run build
npm run fetch-runtime
npm run check:package
npm run smoke:package
npm run dist:desktop
```

再按 `desktop/冒烟清单.md` 在真机上走一遍。**不要**在这一步推 tag、发 Release 或推远端。

- [ ] **Step 6: 提交**

```bash
git add AGENTS.md README.md 停止.cmd 停止.command 停止.sh .env.example desktop/冒烟清单.md
git commit -m "docs(desktop): document the desktop path and how to quit it"
```

---

## Self-Review

### 1. Spec coverage

| Spec 章节 | 落点 |
|---|---|
| Windows 桌面、单实例、菜单、更新、NSIS+zip | Task 1、14、15、16 |
| 随包 node.exe（better-sqlite3 ABI） | Task 1、11、15、16（打包 job 固定 Node 24） |
| 两个根与全部派生路径 | Task 2 |
| 数据锁 | Task 3 |
| 笔记三根、id 冲突、`Note.file` | Task 4（从阶段 3 提前到本计划：首启选旧文件夹必须能读到旧笔记） |
| 边车接管、动态端口、日志、进程树停止、`npm start`/`dev` | Task 6、7、8 |
| `/api/asr/status`、`/api/asr/restart`、`/api/runtime` | Task 8、9 |
| `AsrStatus` 不再说黑窗口 | Task 9 |
| 设置页文案按运行时分叉、STOP_HINT 守卫 | Task 10 |
| 首启向导、桌面前置路径、外链、权限 | Task 13、14 |
| CSP、生产壳 | Task 15 |
| 打包清单、裸 import 守卫、打包冒烟 | Task 15 |
| CI、release、policy | Task 16 |
| 文档改动与冒烟清单 | Task 17 |
| 不做：AI、流式、mac/Linux、全量 Python 包 | 本计划不涉及；AI 在计划二 |

### 2. Placeholder scan

- 计划里没有占位段落、空白实现，也没有「类似 Task N」这种指代。
- 两处**明确**的落地简化，不是占位：`fetch-runtime.mjs` 里 `AdmZip` 的取文件写法用 `entry.getData()` 直接写；`asrManager.defaultKillTree` 用顶层 `import { spawnSync }`（计划里注释了为什么）。
- `npm view …` 的三步是取当前稳定版的动作，不是空值；版本号必须由执行者当场查询后写入。

### 3. Type consistency

- `RuntimePaths` / `DesktopPaths` 的字段名在 Task 2/11/12/14 中一致：`shippedRoot`、`appRoot`、`dataDir`、`localNotes`、`webDist`、`asrProjectDir`。
- `AsrStatus` 在服务端、web 类型与组件里同名同字段：`state`、`port`、`uvFound`、`startedAt`、`error`、`log`。
- `ChildHandle.stop()` 是 async；`main.ts` 在 `will-quit` 里 `void child?.stop()`。
- `serverEnv()` 的 `APP_RUNTIME=desktop` 与 `/api/runtime` 的 `desktop` 一一对应。
- `updateChannelFromPackage` 读 `zhengyinChannel`，两份 builder 配置分别写 `nsis` / `zip`。

### 4. 已知的执行顺序依赖

- Task 2 的 `NoteStore` 仍传单根（过渡），Task 4 才切多根。Task 2 结束时必须仍能跑。
- Task 8 依赖 Task 7 的 `AsrManager`；Task 9 依赖 Task 8 的 `/api/asr/status`。
- Task 14 依赖 Task 11–13 的全部模块。
- Task 15 依赖 Task 11 的 `desktop/vendor` 已下载。
- Task 16 依赖 Task 15 的脚本与配置。
- Task 17 最后做；文档改了之后要再跑一次 `npm test`（`SettingsPage.test.tsx` 会读 `README.md` 的停止提示）。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-10-27-desktop-shell.md`。

按你的偏好，建议**在本会话内直接执行**（inline），每个 Task 结束跑测试并本地提交、不 push；需要独立复核时再单开只读复核，不另派实现者。下一步从 **Task 1** 开始。

