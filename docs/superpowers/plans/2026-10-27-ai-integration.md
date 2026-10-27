# AI 接入 Implementation Plan（计划二）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有服务端加上 AI 四项能力——讲解、存笔记、助教对话、命令行代理整理；接口模式支持 OpenAI / Anthropic / Gemini，命令行模式支持 claude / codex / gemini / agy / 自定义，服务商事实从 `web-tools-by-ai` 同步。

**Architecture:** AI 全在 Hono 服务里（浏览器模式和桌面版共用）：设置与密钥在 `data/ai-settings.json`，上下文由现有分析/笔记/档案派生，接口走三个协议适配器，CLI 走 cross-spawn；前端只发请求、渲染结果、编辑笔记。代理模式的 cwd 是 `APP_ROOT`，可写本机笔记与当前用户档案，不能碰词条库/录音/复习进度。

**Tech Stack:** Hono + better-sqlite3 + gray-matter + cross-spawn；OpenAI Chat Completions / Anthropic Messages / Gemini generateContent（非流式）；React + antd + react-markdown；Vitest。

**Spec:** `docs/superpowers/specs/2026-10-27-electron-ai-design.md`（先读它；本计划实现阶段 3–6）

## Global Constraints

- AI 回复**非流式**；讲解/对话/笔记草稿超时 180s；测试连接 API 30s、CLI 60s；代理 10 分钟。
- 接口模式支持 `openai` / `anthropic` / `gemini`；不支持的协议不展示。
- 密钥只存本机、只回打码、不进日志、不进备份；Gemini 的 `?key=` 在所有错误/日志里脱敏。
- 密钥不是必填项；地址只接受 `http` / `https`；地址换主机时清空密钥。
- `consent` 是服务端强制的闸：讲解/草稿/对话/代理/测试在未确认时 409；读写设置与状态不挡。
- 笔记只写知识，不写个人断言、不写 severity；讲音写 `triggers`、讲词写 `words`、错法写 `contrasts`。
- 笔记 id 与文件名由服务端生成并做路径安全；写入前对三根去重；写入后 `noteStore.load()` + `reconcileAttempts` + `syncProfile`。
- 代理只写本机笔记（`<APP_ROOT>/data/notes`）和当前用户档案；跑前快照、跑后 diff、可撤销；越界改动要告警。
- 页面文案中文；不写「多听多练」；未配置 AI 时给设置入口，不做点下去才失败的按钮。
- 所有新增限制/协议清单只留一处；跨包拷贝（provider 目录、协议集）用「对不上就红」的守卫。
- 测试文件必须进 `vitest.config.ts` 的 include；根 `typecheck` 直接调 `tsc`。

---

## 文件地图

**服务端（新建）**
- `server/src/ai/settings.ts` — 设置读写、打码、合并、地址/协议校验
- `server/src/ai/protocols.ts` — 三协议请求/响应、错误映射、脱敏
- `server/src/ai/cli.ts` — CLI 参数表、存在性、文本/代理运行、进程树
- `server/src/ai/json.ts` — 容错 JSON 抽取
- `server/src/ai/context.ts` — 词/对话/代理上下文
- `server/src/ai/notes.ts` — 草稿解析、frontmatter 组装、校验、写本机笔记
- `server/src/ai/chat.ts` — 每用户对话历史
- `server/src/ai/agent.ts` — 代理运行、快照/diff/撤销、参考副本
- `server/src/ai/locks.ts` — 单飞锁
- `server/src/noteLinks.ts` — 从 app.ts 抽出的 `entryHasNote` / `relevantNotes`
- `server/src/httpGuard.ts` — Origin / Content-Type 中间件

**服务端（修改）**
- `server/src/app.ts` — `AppDeps` 加数据根/路径/AI 依赖；挂 guard；AI 路由；复用 noteLinks
- `server/src/db.ts` — `latestAttemptFor`
- `server/src/index.ts` — 传 dataDir/appRoot/workflowsDir/localNotes/shippedNotes；AI agent 依赖
- `server/package.json` — 加 `cross-spawn`、`which`
- `workflows/coach.md`、`workflows/agent.md` — 提示词正本

**前端（新建）**
- `web/src/vendor/providerCatalog.generated.ts` — 上游生成物（提交）
- `web/src/lib/aiPresets.ts` — 从目录派生预置/模型候选
- `web/src/components/AiSettingsSection.tsx`、`AiCoach.tsx`、`NoteEditor.tsx`
- `web/src/pages/AssistantPage.tsx`、`OrganizePage.tsx`

**前端（修改）**
- `web/src/types.ts`、`web/src/api.ts`、`web/src/pages/SettingsPage.tsx`、`web/src/pages/WordPage.tsx`、`web/src/layout.tsx`

**上游（另一仓库）**
- `tools/web-tools-by-ai/scripts/sync-provider-catalog.ts` — 加 031 消费者路径并运行

---

## Task 1: Provider 目录同步与预置层

**Files:**
- Modify: `D:/Backup/Libraries/Documents/GitHub/tools/web-tools-by-ai/scripts/sync-provider-catalog.ts`
- Create: `web/src/vendor/providerCatalog.generated.ts`、`web/src/lib/aiPresets.ts`、`web/src/lib/aiPresets.test.ts`
- Create dir: `web/src/vendor/`

**Interfaces:**
- Consumes: 上游 `PROVIDERS` 生成物
- Produces: `AI_PRESETS: readonly AiPreset[]`、`visibleAiPresets(showHidden, currentUrl?)`、`modelSuggestionsFor(preset)`、`findPresetByUrl(url)`；`WEB_AI_PROTOCOLS = ['openai','anthropic','gemini']`

- [ ] **Step 1: 上游加消费方并生成**

先建目录（脚本对不存在的父目录只打 warn 就跳过）：

```bash
mkdir -p web/src/vendor
```

在上游 `CONSUMERS` 数组加：

```ts
  // 正音：服务端自己实现 openai / anthropic / gemini 三套适配；
  // azure/yandex 的原生协议不消费。
  "D:/Backup/Libraries/Documents/GitHub/Projects/365/031-zhengyin/web/src/vendor/providerCatalog.generated.ts",
```

运行：

```bash
cd "D:/Backup/Libraries/Documents/GitHub/tools/web-tools-by-ai"
npx tsx scripts/sync-provider-catalog.ts
```

Expected: `written .../031-zhengyin/web/src/vendor/providerCatalog.generated.ts`。

- [ ] **Step 2: 写预置层失败测试**

```ts
// web/src/lib/aiPresets.test.ts
import { describe, it, expect } from 'vitest';
import { AI_PRESETS, findPresetByUrl, visibleAiPresets, WEB_AI_PROTOCOLS } from './aiPresets.js';
import { findProvider } from '../vendor/providerCatalog.generated.js';

describe('AI 预置', () => {
  it('目录里必须有 claude / gemini / 一家 openai', () => {
    expect(findProvider('claude')?.protocol).toBe('anthropic');
    expect(findProvider('gemini')?.protocol).toBe('gemini');
    expect(AI_PRESETS.some((p) => p.protocol === 'openai')).toBe(true);
  });

  it('只暴露服务端实现了的协议', () => {
    expect(new Set(AI_PRESETS.map((p) => p.protocol))).toEqual(new Set(WEB_AI_PROTOCOLS));
    for (const p of AI_PRESETS) expect(WEB_AI_PROTOCOLS).toContain(p.protocol);
  });

  it('hidden 的订阅套餐默认藏起来，当前地址命中时留住', () => {
    const hidden = AI_PRESETS.find((p) => p.hidden);
    if (hidden) {
      expect(visibleAiPresets(false)).not.toContain(hidden);
      expect(visibleAiPresets(false, hidden.url)).toContain(hidden);
    }
  });

  it('按完整地址或 base 能找到同一个预置', () => {
    const p = AI_PRESETS[0]!;
    expect(findPresetByUrl(p.url)?.providerKey).toBe(p.providerKey);
    expect(findPresetByUrl(p.base)?.providerKey).toBe(p.providerKey);
  });
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `npx vitest run web/src/lib/aiPresets.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `aiPresets.ts`**

```ts
import { PROVIDER_CATALOG, type CatalogProvider } from '../vendor/providerCatalog.generated.js';

export const WEB_AI_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type WebAiProtocol = typeof WEB_AI_PROTOCOLS[number];

export interface AiPreset {
  label: string;
  url: string;
  base: string;
  providerKey: string;
  protocol: WebAiProtocol;
  model: string;
  hidden?: boolean;
}

const DISPLAY: Record<string, string> = {
  siliconflow: '硅基流动',
  volcengine: '字节方舟 Coding Plan',
  alibaba: '阿里百炼 Token Plan',
};

const isLocal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url);

const supported = (p: CatalogProvider): p is CatalogProvider & { protocol: WebAiProtocol } =>
  (WEB_AI_PROTOCOLS as readonly string[]).includes(p.protocol) && p.endpoints.length > 0;

const toPreset = (label: string, provider: CatalogProvider, endpointIndex: number, key: string): AiPreset => {
  const e = provider.endpoints[endpointIndex]!;
  return {
    label: isLocal(e.url) ? `${label}（本机）` : label,
    url: e.url,
    base: e.baseUrl,
    providerKey: key,
    protocol: provider.protocol as WebAiProtocol,
    model: provider.models.length === 0 ? '' : (provider.defaultModel ?? ''),
    ...(provider.hidden ? { hidden: true as const } : {}),
  };
};

export const AI_PRESETS: readonly AiPreset[] = PROVIDER_CATALOG
  .filter(supported)
  .flatMap((p) => {
    if (p.endpoints.length > 1 && p.endpoints.every((e) => e.docs)) {
      return p.endpoints.map((e) => {
        const preset = toPreset(e.label, p, p.endpoints.indexOf(e), `custom:${e.url}`);
        return { ...preset };
      });
    }
    return [toPreset(DISPLAY[p.key] ?? p.label, p, 0, p.key)];
  });

export function visibleAiPresets(showHidden: boolean, currentUrl?: string): readonly AiPreset[] {
  if (showHidden) return AI_PRESETS;
  return AI_PRESETS.filter((p) => !p.hidden || (currentUrl !== undefined && p.url === currentUrl));
}

const norm = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
export function findPresetByUrl(url: string): AiPreset | undefined {
  const u = norm(url);
  return AI_PRESETS.find((p) => norm(p.url) === u || norm(p.base) === u);
}

export function modelSuggestionsFor(preset: AiPreset | undefined): string[] {
  if (!preset) return [];
  const provider = PROVIDER_CATALOG.find((p) => p.key === preset.providerKey);
  return provider ? provider.models.map((m) => m.id) : [];
}
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `npx vitest run web/src/lib/aiPresets.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交（031 仓；上游改动单独保留，是否提交/推送以后确认）**

```bash
git add web/src/vendor/providerCatalog.generated.ts web/src/lib/aiPresets.ts web/src/lib/aiPresets.test.ts
git commit -m "feat(ai): derive provider presets from the synced catalog"
```

---

## Task 2: AI 设置存储与合并

**Files:**
- Create: `server/src/ai/settings.ts`、`server/src/ai/settings.test.ts`

**Interfaces:**
- Produces:
  - `AiMode = 'api' | 'cli'`
  - `AiCliKind = 'claude' | 'codex' | 'gemini' | 'agy' | 'custom'`
  - `AiEndpointRecord { protocol: WebAiProtocol; baseUrl; key; model }`（服务端自己定义协议联合，不依赖 web）
  - `AiSettings`：`schemaVersion:1`、`mode`、`endpointId`、`endpoints: Record<string,AiEndpointRecord>`、`cli:{kind,path,customArgs}`、`consent:boolean`
  - `readAiSettings(dataDir): AiSettings`、`writeAiSettings(dataDir,s)`
  - `maskAiSettings(s): AiSettings`（key 变 `••••1234`）
  - `mergeAiSettings(body, stored): AiSettings`
  - `activeAi(s): AiEndpointRecord | null`
  - `AI_PROTOCOLS = ['openai','anthropic','gemini'] as const`

- [ ] **Step 1: 写测试**

```ts
// server/src/ai/settings.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AI_PROTOCOLS, activeAi, mergeAiSettings, maskAiSettings, readAiSettings, writeAiSettings } from './settings.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ai-set-'));

const stored = () => ({
  schemaVersion: 1 as const, consent: true, mode: 'api' as const, endpointId: 'deepseek',
  endpoints: { deepseek: { protocol: 'openai' as const, baseUrl: 'https://a.test/v1', key: 'sk-12345678', model: 'm' } },
  cli: { kind: 'claude' as const, path: '', customArgs: '' },
});

describe('AI 设置', () => {
  it('写入后读回；缺文件回默认', () => {
    const d = dir();
    expect(readAiSettings(d).consent).toBe(false);
    writeAiSettings(d, stored());
    expect(readAiSettings(d).endpointId).toBe('deepseek');
    expect(JSON.parse(readFileSync(join(d, 'ai-settings.json'), 'utf8')).endpoints.deepseek.key).toBe('sk-12345678');
  });

  it('GET 只回打码密钥', () => {
    expect(maskAiSettings(stored()).endpoints.deepseek!.key).toBe('••••5678');
  });

  it('打码回显 = 没动密钥；换主机清空', () => {
    const s = stored();
    const same = mergeAiSettings({ ...s, endpoints: { deepseek: { ...s.endpoints.deepseek, key: '••••5678' } } }, s);
    expect(same.endpoints.deepseek!.key).toBe('sk-12345678');
    const moved = mergeAiSettings({ ...s, endpoints: { deepseek: { ...s.endpoints.deepseek, baseUrl: 'https://b.test/v1', key: '••••5678' } } }, s);
    expect(moved.endpoints.deepseek!.key).toBe('');
  });

  it('空地址的记录被丢弃；非法协议被丢弃', () => {
    const s = mergeAiSettings({
      ...stored(),
      endpointId: 'x',
      endpoints: {
        x: { protocol: 'yandex', baseUrl: 'https://x', key: '', model: 'm' },
        y: { protocol: 'openai', baseUrl: '', key: '', model: 'm' },
      },
    }, stored());
    expect(s.endpoints.x).toBeUndefined();
    expect(s.endpoints.y).toBeUndefined();
    expect(s.endpointId).toBe('');
  });

  it('服务端的协议集与 web 的预置集一致', () => {
    const web = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'src', 'lib', 'aiPresets.ts'), 'utf8');
    expect(web).toContain("['openai', 'anthropic', 'gemini']");
  });

  it('只有 http/https；协议只认三种', () => {
    expect(() => mergeAiSettings({ ...stored(), endpoints: { deepseek: { ...stored().endpoints.deepseek, baseUrl: 'file:///x' } } }, stored()))
      .toThrow(/http/);
    expect(AI_PROTOCOLS).toEqual(['openai', 'anthropic', 'gemini']);
    expect(activeAi(stored())?.model).toBe('m');
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run server/src/ai/settings.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `settings.ts`**

```ts
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';

export const AI_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type AiProtocol = typeof AI_PROTOCOLS[number];
export type AiMode = 'api' | 'cli';
export type AiCliKind = 'claude' | 'codex' | 'gemini' | 'agy' | 'custom';

export interface AiEndpointRecord { protocol: AiProtocol; baseUrl: string; key: string; model: string }
export interface AiSettings {
  schemaVersion: 1;
  consent: boolean;
  mode: AiMode;
  endpointId: string;
  endpoints: Record<string, AiEndpointRecord>;
  cli: { kind: AiCliKind; path: string; customArgs: string };
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  schemaVersion: 1, consent: false, mode: 'api', endpointId: '', endpoints: {},
  cli: { kind: 'claude', path: '', customArgs: '' },
};

const FILE = 'ai-settings.json';
const fileOf = (dataDir: string) => join(dataDir, FILE);
const mask = (key: string) => (key.length <= 4 ? '••••' : `••••${key.slice(-4)}`);

export function maskAiSettings(s: AiSettings): AiSettings {
  const endpoints: Record<string, AiEndpointRecord> = {};
  for (const [id, r] of Object.entries(s.endpoints)) endpoints[id] = { ...r, key: r.key ? mask(r.key) : '' };
  return { ...s, endpoints };
}

function isProtocol(v: unknown): v is AiProtocol { return typeof v === 'string' && (AI_PROTOCOLS as readonly string[]).includes(v); }
function isCliKind(v: unknown): v is AiCliKind { return v === 'claude' || v === 'codex' || v === 'gemini' || v === 'agy' || v === 'custom'; }

function sanitizeEndpoint(raw: unknown, stored: AiEndpointRecord | undefined): AiEndpointRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!baseUrl) return null;
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new Error('AI 接口地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('AI 接口地址只接受 http / https');
  if (!isProtocol(r.protocol)) throw new Error('AI 协议只支持 openai / anthropic / gemini');
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  const prev = stored?.key ?? '';
  const incoming = typeof r.key === 'string' ? r.key.trim() : '';
  const untouched = incoming === '' || (!!prev && incoming === mask(prev));
  const hostMoved = (() => { try { return new URL(stored?.baseUrl ?? '').host !== u.host; } catch { return false; } })();
  return { protocol: r.protocol, baseUrl, model, key: untouched ? (hostMoved ? '' : prev) : incoming };
}

export function mergeAiSettings(body: unknown, stored: AiSettings): AiSettings {
  const b = (body ?? {}) as Partial<AiSettings>;
  const endpoints: Record<string, AiEndpointRecord> = {};
  const rawEndpoints = b.endpoints && typeof b.endpoints === 'object' ? b.endpoints : {};
  for (const [id, raw] of Object.entries(rawEndpoints)) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    const rec = sanitizeEndpoint(raw, stored.endpoints[id]);
    if (rec) endpoints[id] = rec;
  }
  const endpointId = typeof b.endpointId === 'string' && Object.hasOwn(endpoints, b.endpointId) ? b.endpointId : '';
  const cli = (b.cli ?? {}) as Partial<AiSettings['cli']>;
  return {
    schemaVersion: 1,
    consent: b.consent === true,
    mode: b.mode === 'cli' ? 'cli' : 'api',
    endpointId,
    endpoints,
    cli: {
      kind: isCliKind(cli.kind) ? cli.kind : stored.cli.kind,
      path: typeof cli.path === 'string' ? cli.path.trim() : stored.cli.path,
      customArgs: typeof cli.customArgs === 'string' ? cli.customArgs : stored.cli.customArgs,
    },
  };
}

export function readAiSettings(dataDir: string): AiSettings {
  const f = fileOf(dataDir);
  if (!existsSync(f)) return { ...DEFAULT_AI_SETTINGS, endpoints: {}, cli: { ...DEFAULT_AI_SETTINGS.cli } };
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<AiSettings>;
    return mergeAiSettings({ ...DEFAULT_AI_SETTINGS, ...raw }, DEFAULT_AI_SETTINGS);
  } catch { return { ...DEFAULT_AI_SETTINGS, endpoints: {}, cli: { ...DEFAULT_AI_SETTINGS.cli } }; }
}

export function writeAiSettings(dataDir: string, s: AiSettings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(fileOf(dataDir), `${JSON.stringify(s, null, 2)}\n`);
}

export function activeAi(s: AiSettings): AiEndpointRecord | null {
  return s.endpoints[s.endpointId] ?? null;
}
```


- [ ] **Step 4: 跑测试**

Run: `npx vitest run server/src/ai/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/ai/settings.ts server/src/ai/settings.test.ts
git commit -m "feat(ai): store provider settings with masked keys and host-change clearing"
```

---

## Task 3: 三协议适配器

**Files:**
- Create: `server/src/ai/protocols.ts`、`server/src/ai/protocols.test.ts`

**Interfaces:**
- Produces:
  - `SUPPORTED_PROTOCOLS = ['openai','anthropic','gemini'] as const`
  - `AiMessage { role:'system'|'user'|'assistant'; content:string }`
  - `AiConfig { protocol; baseUrl; key; model }`
  - `callAi(config, messages, opts?): Promise<string>`
  - `AiError`（`status: number`，中文 message）
  - `redactUrl(url): string`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { callAi, redactUrl, type AiConfig } from './protocols.js';

const msg = [{ role: 'user' as const, content: 'hi' }];
const cfg = (protocol: AiConfig['protocol'], baseUrl: string): AiConfig =>
  ({ protocol, baseUrl, key: 'sk-1', model: 'm1' });

describe('协议适配', () => {
  it('openai：POST /chat/completions + Bearer，取 content', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect(await callAi(cfg('openai', 'https://a.test/v1'), msg, { fetchFn })).toBe('ok');
    const [url, init] = (fetchFn as any).mock.calls[0];
    expect(url).toBe('https://a.test/v1/chat/completions');
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer sk-1');
  });

  it('anthropic：/v1/messages + x-api-key，只取 text 部件', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'ok' }],
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await callAi(cfg('anthropic', 'https://api.anthropic.com'), msg, { fetchFn })).toBe('ok');
    const [url, init] = (fetchFn as any).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string,string>)['x-api-key']).toBe('sk-1');
  });

  it('gemini：models/<model>:generateContent?key=…，取 candidates parts', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await callAi(cfg('gemini', 'https://generativelanguage.googleapis.com'), msg, { fetchFn })).toBe('ok');
    const [url] = (fetchFn as any).mock.calls[0];
    expect(url).toContain('/v1beta/models/m1:generateContent');
    expect(url).toContain('key=sk-1');
  });

  it('错误映射 + 脱敏', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(callAi(cfg('openai', 'https://a.test/v1'), msg, { fetchFn })).rejects.toMatchObject({ status: 401 });
    expect(redactUrl('https://x/y?key=secret&a=1')).not.toContain('secret');
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run server/src/ai/protocols.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `protocols.ts`**

```ts
export const SUPPORTED_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type AiProtocol = typeof SUPPORTED_PROTOCOLS[number];
export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AiConfig { protocol: AiProtocol; baseUrl: string; key: string; model: string }

export class AiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'AiError'; }
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of ['key', 'api_key', 'api-key', 'token']) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch { return raw.replace(/([?&](?:key|api_key|api-key|token)=)[^&]*/gi, '$1***'); }
}

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');
const chatUrl = (base: string) => {
  const u = trimSlash(base);
  if (u.endsWith('/chat/completions')) return u;
  const path = u.replace(/^https?:\/\/[^/]+/i, '');
  return path === '' ? `${u}/v1/chat/completions` : `${u}/chat/completions`;
};
const messagesUrl = (base: string) => {
  const u = trimSlash(base);
  if (u.endsWith('/messages')) return u;
  const path = u.replace(/^https?:\/\/[^/]+/i, '');
  if (path === '' || path === '/v1') return `${u}/v1/messages`.replace('//v1', '/v1');
  return `${u}/messages`;
};

function systemOf(messages: AiMessage[]): string { return messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'); }
function turns(messages: AiMessage[]) { return messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })); }

async function parseError(res: Response, url: string): Promise<AiError> {
  let detail = '';
  try {
    const b = await res.json() as Record<string, any>;
    detail = b.error?.message ?? b.message ?? '';
  } catch { detail = await res.text().catch(() => ''); }
  const status = res.status;
  const zh = status === 401 || status === 403 ? '密钥被拒绝'
    : status === 404 ? '地址路径不对'
    : status === 429 ? '请求太频繁或额度用尽'
    : status >= 500 ? '服务商故障'
    : '请求失败';
  return new AiError(status, `${zh}（${status}）：${redactUrl(url)}${detail ? `\n${String(detail).slice(0, 300)}` : ''}`);
}

export async function callAi(
  config: AiConfig,
  messages: AiMessage[],
  opts: { fetchFn?: typeof fetch; timeoutMs?: number; maxTokens?: number } = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const maxTokens = opts.maxTokens ?? 4096;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let url: string; let headers: Record<string, string>; let body: unknown;
    if (config.protocol === 'openai') {
      url = chatUrl(config.baseUrl);
      headers = { 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) };
      body = { model: config.model, messages, max_tokens: maxTokens };
    } else if (config.protocol === 'anthropic') {
      url = messagesUrl(config.baseUrl);
      headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(config.key ? { 'x-api-key': config.key } : {}) };
      body = { model: config.model, max_tokens: maxTokens, system: systemOf(messages), messages: turns(messages) };
    } else {
      const base = trimSlash(config.baseUrl).replace(/\/models$/i, '');
      url = `${base}/models/${encodeURIComponent(config.model)}:generateContent${config.key ? `?key=${encodeURIComponent(config.key)}` : ''}`;
      headers = { 'content-type': 'application/json' };
      body = {
        ...(systemOf(messages) ? { systemInstruction: { parts: [{ text: systemOf(messages) }] } } : {}),
        contents: turns(messages).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens },
      };
    }
    const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) throw await parseError(res, url);
    const data = await res.json() as any;
    const text = config.protocol === 'openai'
      ? (typeof data.choices?.[0]?.message?.content === 'string'
        ? data.choices[0].message.content
        : Array.isArray(data.choices?.[0]?.message?.content)
          ? data.choices[0].message.content.map((p: any) => p?.text ?? '').join('') : '')
      : config.protocol === 'anthropic'
        ? (data.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
        : (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
    if (!text.trim()) throw new AiError(502, 'AI 返回了空内容（可能被安全策略拦了）。');
    return text;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as { name?: string }).name === 'AbortError') throw new AiError(504, `AI 超过 ${Math.round(timeoutMs / 1000)}s 没有返回。`);
    throw new AiError(502, `连不上 AI 服务：${redactUrl(config.baseUrl)}（${(e as Error).message}）`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run server/src/ai/protocols.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/ai/protocols.ts server/src/ai/protocols.test.ts
git commit -m "feat(ai): speak OpenAI, Anthropic and Gemini without leaking keys"
```

---

## Task 4: CLI 运行器与状态

**Files:**
- Create: `server/src/ai/cli.ts`、`server/src/ai/cli.test.ts`
- Modify: `server/package.json`（`cross-spawn`、`which`）
- Modify: `package-lock.json`

**Interfaces:**
- Produces:
  - `AI_CLI_KINDS`
  - `resolveCliInvocation(settings, prompt, mode:'text'|'agent'): CliInvocation`
  - `commandExists(command): boolean`
  - `runCliText(invocation, opts): Promise<string>`
  - `runCliAgent(invocation, opts): Promise<{code:number|null; output:string}>`
  - `killTree(pid)`

- [ ] **Step 1: 装依赖**

```bash
npm install cross-spawn@^7 -w server
npm install -D @types/cross-spawn -w server
npm install which@^5 -w server
```

（`which` 自带类型；没有的话加 `@types/which`。它只用于状态检查，`cross-spawn` 负责真正启动 `.cmd`。）

- [ ] **Step 2: 写测试**

```ts
import { describe, it, expect } from 'vitest';
import { resolveCliInvocation } from './cli.js';

const s = (kind: any, path = '', customArgs = '') => ({ cli: { kind, path, customArgs } });

describe('CLI 参数', () => {
  it('claude 文本模式禁掉全部工具', () => {
    const inv = resolveCliInvocation(s('claude'), 'P', 'text');
    expect(inv.args).toContain('--tools');
    expect(inv.args[inv.args.indexOf('--tools') + 1]).toBe('');
    expect(inv.args).toContain('--output-format');
  });

  it('claude 代理模式给读写工具', () => {
    const inv = resolveCliInvocation(s('claude'), 'P', 'agent');
    expect(inv.args.join(' ')).toContain('--allowedTools Read,Edit,Write,Glob,Grep');
  });

  it('codex / gemini 文本模式是只读/plan；代理模式可写', () => {
    expect(resolveCliInvocation(s('codex'), 'P', 'text').args).toContain('read-only');
    expect(resolveCliInvocation(s('codex'), 'P', 'agent').args).toContain('workspace-write');
    expect(resolveCliInvocation(s('gemini'), 'P', 'text').args).toContain('plan');
    expect(resolveCliInvocation(s('gemini'), 'P', 'agent').args).toContain('auto_edit');
  });

  it('custom 的 {prompt} 占位；没写就追加', () => {
    expect(resolveCliInvocation(s('custom', 'my-cli', '--x {prompt}'), 'P', 'text').args).toEqual(['--x', 'P']);
    expect(resolveCliInvocation(s('custom', 'my-cli', '--x'), 'P', 'text').args).toEqual(['--x', 'P']);
  });
});
```

- [ ] **Step 3: 实现 `cli.ts`**

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import which from 'which';

export const AI_CLI_KINDS = ['claude', 'codex', 'gemini', 'agy', 'custom'] as const;
export type AiCliKind = typeof AI_CLI_KINDS[number];
export interface CliSettings { kind: AiCliKind; path: string; customArgs: string }
export interface CliInvocation { command: string; args: string[]; displayName: string }

export function parseCustomArgs(template: string, prompt: string): string[] {
  const tokens: string[] = [];
  let cur = ''; let dq = false; let sq = false; let used = false;
  const push = () => { if (!cur) return; if (cur.includes('{prompt}')) { used = true; cur = cur.replaceAll('{prompt}', prompt); } tokens.push(cur); cur = ''; };
  for (const ch of template.trim()) {
    if (ch === '"' && !sq) dq = !dq;
    else if (ch === "'" && !dq) sq = !sq;
    else if (/\s/.test(ch) && !dq && !sq) push();
    else cur += ch;
  }
  push();
  if (!used) tokens.push(prompt);
  return tokens;
}

export function resolveCliInvocation(s: { cli: CliSettings }, prompt: string, mode: 'text' | 'agent'): CliInvocation {
  const { kind, path, customArgs } = s.cli;
  const custom = path.trim();
  if (kind === 'codex') return {
    command: custom || 'codex', displayName: 'codex',
    args: ['exec', '--sandbox', mode === 'agent' ? 'workspace-write' : 'read-only', '--skip-git-repo-check', prompt],
  };
  if (kind === 'gemini') return {
    command: custom || 'gemini', displayName: 'gemini',
    args: ['-p', prompt, '--approval-mode', mode === 'agent' ? 'auto_edit' : 'plan', '-o', 'json'],
  };
  if (kind === 'agy') return {
    command: custom || 'agy', displayName: 'agy',
    args: mode === 'agent' ? ['-p', prompt, '--mode', 'accept-edits', '--dangerously-skip-permissions'] : ['-p', prompt],
  };
  if (kind === 'custom') return {
    command: custom || 'claude', displayName: custom || 'claude',
    args: parseCustomArgs(customArgs, prompt),
  };
  return {
    command: custom || 'claude', displayName: 'claude',
    args: mode === 'agent'
      ? ['-p', prompt, '--tools', 'Read,Edit,Write,Glob,Grep', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--output-format', 'json']
      : ['-p', prompt, '--tools', '', '--permission-prompts', 'none', '--output-format', 'json', '--no-session-persistence'],
  };
}

export function commandExists(command: string): boolean {
  try { return Boolean(which.sync(command, { nothrow: true })); } catch { return false; }
}

function parseText(raw: string, kind: AiCliKind): string {
  const s = raw.trim();
  if (kind === 'claude' || kind === 'gemini') {
    try {
      const j = JSON.parse(s) as any;
      const v = j.result ?? j.response ?? j.text;
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch { /* 回落原文 */ }
  }
  return s;
}

export async function runCliText(inv: CliInvocation, opts: { timeoutMs?: number; cwd?: string; kind?: AiCliKind } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const child = crossSpawn(inv.command, inv.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; let err = '';
  child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr?.on('data', (b: Buffer) => { err += b.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } reject(new Error(`命令行 AI 超过 ${Math.round(timeoutMs / 1000)}s 没有返回`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`起不了 ${inv.displayName}：${e.message}。去设置里检查路径，或改用接口模式。`)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${inv.displayName} 退出码 ${code ?? '未知'}：${err.trim().slice(-500) || out.trim().slice(-500)}`));
      const text = parseText(out, opts.kind ?? 'custom');
      if (!text) return reject(new Error(`${inv.displayName} 没有输出任何内容`));
      resolve(text);
    });
  });
}

export async function runCliAgent(inv: CliInvocation, opts: { cwd: string; timeoutMs?: number; onLog: (line: string) => void }): Promise<{ code: number | null; output: string }> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const child = crossSpawn(inv.command, inv.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  const onData = (b: Buffer) => { const s = b.toString(); out += s; for (const line of s.split(/[\r\n]+/)) if (line.trim()) opts.onLog(line.trimEnd()); };
  child.stdout?.on('data', onData); child.stderr?.on('data', onData);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { killTree(child.pid); reject(new Error('AI 整理超过 10 分钟，已经中止')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`起不了 ${inv.displayName}：${e.message}`)); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output: out }); });
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run server/src/ai/cli.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/ai/cli.ts server/src/ai/cli.test.ts server/package.json package-lock.json
git commit -m "feat(ai): run text and agent CLIs without shell injection"
```

---

## Task 5: HTTP 写请求守卫

**Files:**
- Create: `server/src/httpGuard.ts`、`server/src/httpGuard.test.ts`
- Modify: `server/src/app.ts`

**Interfaces:**
- Produces: `writeGuard()`（Hono middleware）；`originAllowed(origin, host)`；`contentTypeAllowed(ct)`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { writeGuard } from './httpGuard.js';

const app = () => {
  const a = new Hono();
  a.use('*', writeGuard());
  a.post('/x', (c) => c.json({ ok: true }));
  return a;
};

describe('写请求守卫', () => {
  it('没有 Origin、JSON → 放行', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('恶意 Origin → 403', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('text/plain 的简单请求 → 403', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('octet-stream（录音）放行', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' });
    expect(r.status).toBe(200);
  });

  it('GET 不受影响', async () => {
    const a = new Hono(); a.use('*', writeGuard()); a.get('/x', (c) => c.text('ok'));
    expect((await a.request('/x', { headers: { origin: 'https://evil.test' } })).status).toBe(200);
  });
});
```

- [ ] **Step 2: 实现 `httpGuard.ts`**

```ts
import type { MiddlewareHandler } from 'hono';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_CT = ['application/json', 'application/octet-stream'];

export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (LOOPBACK.has(o.hostname)) return true;
    return Boolean(host) && o.host === host;
  } catch { return false; }
}

export function contentTypeAllowed(ct: string | undefined): boolean {
  if (!ct) return true;
  const base = ct.split(';')[0]!.trim().toLowerCase();
  return ALLOWED_CT.includes(base);
}

export function writeGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (WRITE.has(c.req.method)) {
      if (!originAllowed(c.req.header('origin'), c.req.header('host'))) {
        return c.json({ error: '跨站请求被拒绝' }, 403);
      }
      if (!contentTypeAllowed(c.req.header('content-type'))) {
        return c.json({ error: '写请求只接受 JSON 或二进制音频' }, 403);
      }
    }
    await next();
  };
}
```

- [ ] **Step 3: 在 `app.ts` 挂上**

在 `const app = new Hono();` 之后、任何 `/api` 路由之前：

```ts
app.use('*', writeGuard());
```

- [ ] **Step 4: 跑测试与全量**

Run: `npx vitest run server/src/httpGuard.test.ts server/src/app.test.ts`
Expected: PASS（现有测试的 content-type 都是 JSON / octet-stream；没有 Origin）

- [ ] **Step 5: 提交**

```bash
git add server/src/httpGuard.ts server/src/httpGuard.test.ts server/src/app.ts
git commit -m "feat(server): reject cross-site and non-JSON writes"
```

---

## Task 6: 上下文组装与最近一次录音

**Files:**
- Create: `server/src/noteLinks.ts`、`server/src/ai/context.ts`、`server/src/ai/context.test.ts`
- Modify: `server/src/app.ts`（改用 noteLinks）、`server/src/db.ts`（`latestAttemptFor`）、`server/src/db.test.ts`

**Interfaces:**
- Produces:
  - `entryHasNote(entry, note)`、`relevantNotes(deps, text, hits)`（从 app.ts 原样搬出）
  - `latestAttemptFor(db, entryText)`：`{id,target,at,targetIpa:string[],heardIpa:string[],errors:Array<{kind,targetIpa,heardIpa,atIndex}>} | null`
  - `buildWordContext(deps, word, target?): AiContext`
  - `buildChatContext(deps, message): AiContext`
  - `buildAgentPrompt(deps, task, note?): string`

- [ ] **Step 1: 抽 noteLinks + 写上下文测试**

把 app.ts 的 `entryHasNote`/`relevantNotes` 原样移进 `server/src/noteLinks.ts`（deps 只要 `{db,noteStore}`），app.ts 从那里导入；跑 `app.test.ts` 确认无行为变化。

`db.test.ts` 加：

```ts
it('latestAttemptFor 给出最近一次的错误与位置', () => {
  const db = openDb(':memory:');
  const id = logAttempt(db, { entryText: 'click', target: 'click', at: 't1', targetIpa: ['k','l','ɪ','k'], heardIpa: ['k','n','ɪ','k'], clean: false, ops: [
    { kind: 'sub', targetIpa: 'l', heardIpa: 'n' },
  ]});
  const a = latestAttemptFor(db, 'click');
  expect(a?.id).toBe(id);
  expect(a?.errors).toEqual([{ kind: 'sub', targetIpa: 'l', heardIpa: 'n', atIndex: 1 }]);
});
```

`context.test.ts`：

```ts
it('词上下文包含音标、最近错误、相关笔记与发音要点', () => {
  const ctx = buildWordContext(deps, 'click');
  expect(ctx.text).toContain('/klɪk/');
  expect(ctx.text).toContain('l→n');
  expect(ctx.text).toContain('舌尖');
  expect(ctx.sources.some((s) => s.id === 'l-vs-n')).toBe(true);
});
```

- [ ] **Step 2: 实现 `latestAttemptFor`**

```ts
export function latestAttemptFor(db: Database.Database, entryText: string): {
  id: number; target: string; at: string; targetIpa: string[]; heardIpa: string[];
  errors: Array<{ kind: 'sub'|'del'|'ins'; targetIpa: string|null; heardIpa: string|null; atIndex: number }>;
} | null {
  const row = db.prepare('SELECT id, target, at, target_ipa, heard_ipa FROM attempt WHERE entry_text = ? ORDER BY id DESC LIMIT 1').get(entryText) as
    { id: number; target: string; at: string; target_ipa: string; heard_ipa: string } | undefined;
  if (!row) return null;
  const errors = db.prepare('SELECT kind, target_ipa, heard_ipa, at_index FROM attempt_error WHERE attempt_id = ? ORDER BY at_index')
    .all(row.id) as Array<{ kind: 'sub'|'del'|'ins'; target_ipa: string|null; heard_ipa: string|null; at_index: number }>;
  return { id: row.id, target: row.target, at: row.at, targetIpa: row.target_ipa.split(' ').filter(Boolean), heardIpa: row.heard_ipa.split(' ').filter(Boolean),
    errors: errors.map((e) => ({ kind: e.kind, targetIpa: e.target_ipa, heardIpa: e.heard_ipa, atIndex: e.at_index })) };
}
```

- [ ] **Step 3: 实现 `context.ts`**

```ts
export interface AiContext { text: string; sources: Array<{ id: string; title: string }> }
export interface AiContextDeps {
  db: Database.Database; noteStore: NoteStore; profileFile: string;
  readFile?: (p: string) => string;
}

const profileText = (d: AiContextDeps): string => {
  try { return (d.readFile ?? ((p) => readFileSync(p, 'utf8')))(d.profileFile).slice(0, 8000); }
  catch { return ''; }
};

export function buildWordContext(d: AiContextDeps, word: string, target?: string): AiContext {
  const entry = store.getEntry(d.db, word);
  if (!entry) return { text: `词库里没有 ${word}。`, sources: [] };
  const attempt = store.latestAttemptFor(d.db, word);
  const errors = attempt?.errors ?? [];
  const hits = matchNotes([...new Set(entry.words.flatMap((w) => w.tags))], d.noteStore.all(), entry.text);
  const rel = relevantNotes(d, word, hits);
  const notes = d.noteStore.all().filter((n) => rel.has(n.id)).slice(0, 3);
  const stats = store.phonemeStats(d.db, 12);
  const lines = [
    `# 发音档案\n${profileText(d)}`,
    `# 词条\n${entry.text}：${entry.words.map((w) => `${w.word} /${w.ipa}/`).join('；')}`,
    `# 最近一次录音\n${attempt ? `目标 ${attempt.targetIpa.join(' ')}，听到 ${attempt.heardIpa.join(' ')}；错：${errors.map((e) => `${e.kind} ${e.targetIpa ?? ''}→${e.heardIpa ?? ''} @${e.atIndex}`).join('，') || '无'}` : '这个词还没有录音。'}`,
    `# 高频错误\n${stats.slice(0, 8).map((s) => `${s.targetIpa ?? ''}→${s.heardIpa ?? ''} ${s.count} 次`).join('\n')}`,
    `# 相关笔记\n${notes.map((n) => `## ${n.title}\n${n.markdown.slice(0, 3000)}`).join('\n\n')}`,
    `# 错误音素的发音要点\n${[...new Set(errors.flatMap((e) => [e.targetIpa, e.heardIpa]).filter(Boolean))].map((p) => `${p}：${howToPronounce(p!) ?? '暂无'}`).join('\n')}`,
  ];
  return { text: lines.join('\n\n'), sources: notes.map((n) => ({ id: n.id, title: n.title })) };
}

export function buildChatContext(d: AiContextDeps, message: string): AiContext {
  const profile = profileText(d);
  const stats = store.phonemeStats(d.db, 10);
  const words = tokenize(message)
    .map((w) => w.toLowerCase())
    .filter((w) => store.getEntry(d.db, w));
  const ipaSymbols = new Set(Object.values(IPA));
  const mentioned = [...ipaSymbols].filter((s) => message.includes(s));
  const candidates = d.noteStore.all().filter((n) =>
    n.triggers.some((t) => mentioned.some((s) => t === `phoneme:${s}`)) ||
    n.words.some((w) => words.includes(w)));
  const notes = candidates.slice(0, 3);
  const wordBlocks = words.map((w) => {
    const entry = store.getEntry(d.db, w)!;
    const errors = store.errorsOnWord(d.db, w).slice(0, 5)
      .map((e) => `${e.targetIpa ?? ''}→${e.heardIpa ?? ''} ${e.count} 次`).join('，');
    return `${w} /${entry.words.map((x) => x.ipa).join(' ')}/：${errors || '这个词还没错过'}`;
  });
  const text = [
    `# 发音档案
${profile}`,
    `# 最近的高频错误
${stats.map((s) => `${s.targetIpa ?? ''}→${s.heardIpa ?? ''} ${s.count} 次`).join('
')}`,
    `# 消息里提到的词
${wordBlocks.join('
') || '（没有库里已有的词）'}`,
    `# 笔记索引
${d.noteStore.all().map((n) => `- ${n.title}（${n.id}）`).join('
')}`,
    `# 可能相关的笔记
${notes.map((n) => `## ${n.title}
${n.markdown.slice(0, 2500)}`).join('

')}`,
  ].join('

');
  return { text, sources: notes.map((n) => ({ id: n.id, title: n.title })) };
}

export function buildAgentPrompt(d: AiContextDeps & { appRoot: string; workflowsDir: string; userName: string }, task: string, note?: string): string {
  return [
    `你在为正音做一次「AI 整理」。当前用户：${userName}。`,
    `先读 ${join(d.workflowsDir, 'agent.md')}，再读参考副本 ${join(d.appRoot, '.ai-reference', 'agent.md')}。`,
    `可用：当前用户档案 ${d.profileFile}、本机笔记 ${join(d.appRoot, 'data', 'notes')}、参考笔记 ${join(d.appRoot, '.ai-reference', 'notes')}。`,
    `只允许写本机笔记与当前用户档案的「已确认的习惯问题」「待观察」两节；不要动词条库、录音记录、复习进度。`,
    `任务：${task}${note ? `\n补充要求：${note}` : ''}`,
  ].join('\n\n');
}
```


- [ ] **Step 4: 跑测试**

Run: `npx vitest run server/src/ai/context.test.ts server/src/db.test.ts server/src/app.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/noteLinks.ts server/src/ai/context.ts server/src/ai/context.test.ts server/src/db.ts server/src/db.test.ts server/src/app.ts
git commit -m "feat(ai): build word and chat context from the existing analysis"
```

---

## Task 7: 提示词、笔记草稿与写入

**Files:**
- Create: `workflows/coach.md`、`workflows/agent.md`、`server/src/ai/json.ts`、`server/src/ai/json.test.ts`、`server/src/ai/notes.ts`、`server/src/ai/notes.test.ts`
- Modify: `server/src/app.ts`（`POST /api/notes`）
- Modify: `server/src/index.ts`（传 `localNotes`）

**Interfaces:**
- Produces:
  - `extractJson(text): unknown`
  - `parseNoteDraft(text): {title,scope,values,contrasts,body}`
  - `saveAiNote(deps, draft): {id, title, file}`
  - `POST /api/notes`

- [ ] **Step 1: 写提示词正本**

`workflows/coach.md` 至少写全这些（用第二人称给模型）：

```md
# 正音 AI 教练

- 读者是中文母语者，目标口音是美式英语（General American）。用中文回答。
- 只用提供的档案、词条、录音结果和笔记；没有的数据不要编。
- 讲解要落到身体动作：舌尖顶哪、气流走鼻腔/口腔两侧、唇形展或圆；不要写「多听多练」。
- 笔记只写知识，不写对某个人的诊断；不写 severity；讲音写 triggers，讲词写 words，错法写 contrasts。
- 笔记必须有「自检法」和「对比训练」两节；对比训练先给中文对照，再给英文。
- 被要求输出 JSON 时，只输出 JSON，不要围栏或解释。
```

`workflows/agent.md` 写代理的行为边界：读档案/统计/笔记；只写本机笔记和档案的手写两节；门槛（用户自己认，或 ≥3 次且跨 ≥2 个词）；不改 AUTO 块；最后列出改了哪些文件。

- [ ] **Step 2: 写 JSON 抽取与笔记测试**

```ts
// server/src/ai/notes.test.ts
import { describe, it, expect } from 'vitest';
import { parseNoteDraft, saveAiNote } from './notes.js';
// deps fixture 用 app.test 的 testDeps（需要 dataDir/localNotes 字段）

it('草稿只接受 phoneme / word 两种 scope', () => {
  expect(parseNoteDraft('{"title":"x","scope":"phoneme","values":["l"],"body":"## 自检法\\n捏鼻。\\n## 对比训练\\n老/脑"}').scope).toBe('phoneme');
  expect(() => parseNoteDraft('{"title":"x","scope":"nope","values":[],"body":""}')).toThrow(/scope/);
});

it('写入本机笔记：frontmatter 由服务端拼，id 不撞已有三根', () => {
  const r = saveAiNote(deps, { title: 'l 和 n', scope: 'phoneme', values: ['l','n'], contrasts: [], body: '## 自检法\n捏鼻。\n\n## 对比训练\n老/脑' });
  expect(r.id).toMatch(/^[a-z0-9-]+$/);
  expect(deps.noteStore.get(r.id)?.source).toBe('local');
  expect(readFileSync(join(deps.localNotes, `${r.id}.md`), 'utf8')).toContain('triggers:');
});
```

- [ ] **Step 3: 实现 `json.ts` / `notes.ts`**

`extractJson` 照 035：围栏、前后闲话、单键对象都认。

`notes.ts` 关键逻辑：

```ts
export function parseNoteDraft(raw: string): NoteDraft {
  const j = extractJson(raw) as any;
  if (!j || typeof j !== 'object') throw new Error('AI 没有返回 JSON 对象');
  const scope = j.scope === 'phoneme' || j.scope === 'word' ? j.scope : null;
  if (!scope) throw new Error('AI 返回的 scope 只能是 phoneme 或 word');
  const values = Array.isArray(j.values) ? j.values.map(String).filter(Boolean) : [];
  if (values.length === 0) throw new Error('AI 没有给出适用范围');
  const body = typeof j.body === 'string' ? j.body.trim() : '';
  if (!body) throw new Error('AI 没有给出正文');
  return { title: String(j.title ?? 'AI 笔记').trim() || 'AI 笔记', scope, values, contrasts: Array.isArray(j.contrasts) ? j.contrasts.map(String).filter(Boolean) : [], body };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);

export function saveAiNote(d: AiNotesDeps, draft: NoteDraft): { id: string; title: string; file: string } {
  const scopeTags = draft.scope === 'phoneme' ? draft.values.map((v) => `phoneme:${v}`) : [];
  const words = draft.scope === 'word' ? draft.values.map((v) => v.trim().toLowerCase()) : [];
  let id = `ai-${draft.scope}-${slug(draft.title) || hash(draft.title)}`;
  const family = new Set(d.noteStore.all().map((n) => n.id));
  while (family.has(id) || existsSync(join(d.localNotes, `${id}.md`))) id = `${id.replace(/-\d+$/, '')}-${Math.floor(Math.random() * 900 + 100)}`;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('生成的笔记 id 不安全');
  const md = matterStringify(draft.body, {
    id, title: draft.title,
    ...(scopeTags.length ? { triggers: scopeTags } : { words }),
    ...(draft.contrasts.length ? { contrasts: draft.contrasts } : {}),
  });
  const temp: Note = { id, title: draft.title, triggers: scopeTags, contrasts: draft.contrasts, words, severity: 'info', markdown: draft.body, file: `${id}.md`, source: 'local' };
  const warnings = [...validateTriggers([temp]), ...validateShape([temp])];
  if (warnings.length) throw new Error(`笔记没通过校验：\n${warnings.join('\n')}`);
  mkdirSync(d.localNotes, { recursive: true });
  writeFileAtomic(join(d.localNotes, `${id}.md`), md);
  d.noteStore.load();
  reconcileAttempts(d.db, d.noteStore.all());
  syncProfile(d.profileFile, d.db, d.noteStore, d.now());
  return { id, title: draft.title, file: `${id}.md` };
}
```

`matterStringify` 用 `matter.stringify(body, data)`。`contrasts` 只写 IPA 符号；`validateTriggers` 会检查。

- [ ] **Step 4: `POST /api/notes` 路由**

```ts
app.post('/api/notes', async (c) => {
  const body = await c.req.json().catch(() => null) as NoteDraft | null;
  if (!body) return c.json({ error: '请求体不是 JSON' }, 400);
  try {
    const r = saveAiNote({ ...deps, localNotes: deps.localNotes, now: deps.now() }, body);
    return c.json(r);
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
```

- [ ] **Step 5: 跑测试**

Run: `npx vitest run server/src/ai/notes.test.ts server/src/ai/json.test.ts server/src/app.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add workflows/coach.md workflows/agent.md server/src/ai/json.ts server/src/ai/json.test.ts server/src/ai/notes.ts server/src/ai/notes.test.ts server/src/app.ts server/src/index.ts
git commit -m "feat(ai): turn a draft into a validated local note"
```

---

## Task 8: AI 路由与 AppDeps 接线

**Files:**
- Create: `server/src/ai/run.ts`、`server/src/ai/run.test.ts`
- Modify: `server/src/app.ts`、`server/src/app.test.ts`、`server/src/index.ts`

**Interfaces:**
- Consumes: Task 2/3/4/6/7
- Produces:
  - `runAiText(settings, messages, opts?)` → `{text, provider}`（API/CLI 分流）
  - `GET/PUT /api/ai/settings`、`GET /api/ai/status`、`POST /api/ai/test`
  - `POST /api/ai/explain`、`POST /api/ai/note-draft`
  - `AppDeps.aiRun`（可注入）、`AppDeps.dataDir`、`appRoot`、`workflowsDir`、`localNotes`、`shippedNotes`

- [ ] **Step 1: 写接口测试**

在 `app.test.ts` 的 fixture 加：

```ts
dataDir: mkdtempSync(join(tmpdir(), 'data-')),
appRoot: process.cwd(),
workflowsDir: join(process.cwd(), 'workflows'),
localNotes: join(mkdtempSync(join(tmpdir(), 'localnotes-'))),
shippedNotes: join(process.cwd(), 'notes'),
aiRun: vi.fn(async () => ({ text: '## 讲解\n把舌尖顶上去。', provider: '接口·test' })),
```

追加测试：

```ts
it('GET/PUT /api/ai/settings 打码保存；consent 默认为 false', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const got = await (await app.request('/api/ai/settings')).json();
  expect(got.consent).toBe(false);
  const saved = await app.request('/api/ai/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consent: true, mode: 'api', endpointId: 'x', endpoints: { x: { protocol: 'openai', baseUrl: 'https://a.test/v1', key: 'sk-12345678', model: 'm' } }, cli: { kind: 'claude', path: '', customArgs: '' } }),
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).endpoints.x.key).toBe('••••5678');
});

it('未 consent 时讲解/测试返回 409；设置和状态不挡', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const r = await app.request('/api/ai/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ word: 'click' }) });
  expect(r.status).toBe(409);
  expect((await app.request('/api/ai/status')).status).toBe(200);
  expect((await app.request('/api/ai/settings')).status).toBe(200);
});

it('consent 后讲解走注入的 aiRun，返回 markdown 与参考来源', async () => {
  const deps = testDeps();
  deps.aiRun = vi.fn(async () => ({ text: '## 讲解', provider: '接口·test' }));
  // 先写一份 consent=true、带可用 endpoint 的设置
  await createApp(deps).request('/api/ai/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, mode: 'api', endpointId: 'x', endpoints: { x: { protocol: 'openai', baseUrl: 'https://a.test/v1', key: '', model: 'm' } }, cli: { kind: 'claude', path: '', customArgs: '' } }) });
  const res = await createApp(deps).request('/api/ai/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ word: 'click' }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.markdown).toContain('讲解');
  expect(Array.isArray(body.sources)).toBe(true);
  expect(deps.aiRun).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 实现 `run.ts`**

```ts
import { activeAi, type AiSettings } from './settings.js';
import { callAi, AiError, type AiMessage } from './protocols.js';
import { resolveCliInvocation, runCliText } from './cli.js';

export async function runAiText(
  settings: AiSettings,
  messages: AiMessage[],
  opts: { timeoutMs?: number; cwd?: string; fetchFn?: typeof fetch } = {},
): Promise<{ text: string; provider: string }> {
  if (settings.mode === 'cli') {
    const prompt = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
    const inv = resolveCliInvocation(settings, prompt, 'text');
    const text = await runCliText(inv, { timeoutMs: opts.timeoutMs ?? 180_000, cwd: opts.cwd, kind: settings.cli.kind });
    return { text, provider: `命令行·${inv.displayName}` };
  }
  const rec = activeAi(settings);
  if (!rec) throw new AiError(409, '还没选 AI 接口。去设置里选一家、填地址和模型。');
  if (!rec.model.trim()) throw new AiError(409, '设置里的 AI 模型名还没填。');
  const text = await callAi(rec, messages, { timeoutMs: opts.timeoutMs, fetchFn: opts.fetchFn });
  return { text, provider: `接口·${rec.model}` };
}

export function aiStatus(settings: AiSettings, commandExists: (c: string) => boolean): {
  configured: boolean; mode: 'api'|'cli'; consent: boolean; provider: string | null; reason: string | null;
} {
  if (settings.mode === 'cli') {
    const inv = resolveCliInvocation(settings, '', 'text');
    const ok = commandExists(inv.command);
    return { configured: ok, mode: 'cli', consent: settings.consent, provider: inv.displayName, reason: ok ? null : `没找到 ${inv.displayName}` };
  }
  const rec = activeAi(settings);
  if (!rec) return { configured: false, mode: 'api', consent: settings.consent, provider: null, reason: '还没选接口' };
  if (!rec.baseUrl.trim()) return { configured: false, mode: 'api', consent: settings.consent, provider: rec.model || null, reason: '接口地址还没填' };
  if (!rec.model.trim()) return { configured: false, mode: 'api', consent: settings.consent, provider: null, reason: '模型名还没填' };
  return { configured: true, mode: 'api', consent: settings.consent, provider: `${rec.protocol}·${rec.model}`, reason: null };
}
```

- [ ] **Step 3: 在 `app.ts` 加路由**

`AppDeps` 加：

```ts
dataDir: string; appRoot: string; workflowsDir: string; localNotes: string; shippedNotes: string;
aiRun?: (messages: AiMessage[], opts?: { timeoutMs?: number }) => Promise<{ text: string; provider: string }>;
```

路由（放在其他 API 路由附近）：

```ts
const aiSettings = () => readAiSettings(deps.dataDir);
const run = deps.aiRun ?? ((messages, opts) => runAiText(aiSettings(), messages, opts));
const requireConsent = () => { if (!aiSettings().consent) throw new AiError(409, '先在设置里确认：使用 AI 会把发音档案、相关笔记和这次的错误发给你选的服务。'); };

app.get('/api/ai/settings', (c) => c.json(maskAiSettings(aiSettings())));
app.put('/api/ai/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: '请求体不是 JSON' }, 400);
  try {
    const next = mergeAiSettings(body, aiSettings());
    writeAiSettings(deps.dataDir, next);
    return c.json(maskAiSettings(next));
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});
app.get('/api/ai/status', (c) => c.json({ ...aiStatus(aiSettings(), commandExists), consent: aiSettings().consent }));
app.post('/api/ai/test', async (c) => {
  try {
    requireConsent();
    const t0 = Date.now();
    const r = await run([{ role: 'user', content: '只回复 OK 两个字母。' }], { timeoutMs: 60_000 });
    return c.json({ ok: true, latencyMs: Date.now() - t0, sample: r.text.slice(0, 80), provider: r.provider });
  } catch (e) { return c.json({ ok: false, error: (e as Error).message }, e instanceof AiError ? e.status : 502); }
});
app.post('/api/ai/explain', async (c) => {
  const release = tryLock('explain');
  if (!release) return c.json({ error: '上一次讲解还在跑，等它结束再试' }, 409);
  try {
    requireConsent();
    const body = await c.req.json().catch(() => ({})) as { word?: string; target?: string };
    const word = (body.word ?? '').trim().toLowerCase();
    if (!word) return c.json({ error: '缺 word' }, 400);
    const ctx = buildWordContext(deps, word, body.target);
    const coach = readCoach(deps.workflowsDir);
    const r = await run([
      { role: 'system', content: coach },
      { role: 'user', content: `${ctx.text}\n\n请按上面的规则讲解「${word}」，不要重复用户的统计，直接给结论、身体动作、自检和对比。` },
    ]);
    return c.json({ markdown: r.text, sources: ctx.sources, provider: r.provider });
  } catch (e) { return c.json({ error: (e as Error).message }, e instanceof AiError ? e.status : 502); }
  finally { release(); }
});
app.post('/api/ai/note-draft', async (c) => {
  const release = tryLock('note-draft');
  if (!release) return c.json({ error: '上一次生成草稿还在跑，等它结束再试' }, 409);
  try {
    requireConsent();
    const body = await c.req.json().catch(() => ({})) as { word?: string; target?: string };
    const word = (body.word ?? '').trim().toLowerCase();
    if (!word) return c.json({ error: '缺 word' }, 400);
    const ctx = buildWordContext(deps, word, body.target);
    const coach = readCoach(deps.workflowsDir);
    const r = await run([
      { role: 'system', content: coach },
      { role: 'user', content: `${ctx.text}

请为「${word}」写一篇笔记草稿。只输出 JSON：{"title":"…","scope":"phoneme"|"word","values":["…"],"contrasts":["…"],"body":"markdown"}。body 必须包含「## 自检法」和「## 对比训练」两节；不要写个人断言，不要写 severity。` },
    ]);
    const draft = parseNoteDraft(r.text);
    return c.json({ ...draft, provider: r.provider, sources: ctx.sources });
  } catch (e) { return c.json({ error: (e as Error).message }, e instanceof AiError ? e.status : 502); }
  finally { release(); }
});
```

`readCoach(workflowsDir)` 读 `coach.md`，缺了抛 `AiError(500, '提示词文件缺失…')`。

- [ ] **Step 4: 接线 `index.ts`**

```ts
const app = createApp({
  ...,
  dataDir: runtime.dataDir,
  appRoot: runtime.appRoot,
  workflowsDir: runtime.workflowsDir,
  localNotes: runtime.localNotes,
  shippedNotes: runtime.shippedNotes,
});
```

- [ ] **Step 5: 跑测试**

Run: `npx vitest run server/src/app.test.ts server/src/ai/run.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/ai/run.ts server/src/ai/run.test.ts server/src/app.ts server/src/app.test.ts server/src/index.ts
git commit -m "feat(ai): expose settings, status, test, explain and note drafts"
```

---

## Task 9: AI 设置界面

**Files:**
- Create: `web/src/components/AiSettingsSection.tsx`、`AiSettingsSection.test.tsx`
- Modify: `web/src/api.ts`、`web/src/types.ts`、`web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `AI_PRESETS` / `visibleAiPresets` / `modelSuggestionsFor`、`/api/ai/settings`
- Produces: 设置页里的「AI 讲解」卡

- [ ] **Step 1: 写测试**

```tsx
it('默认是接口模式；点服务商芯片填地址与模型；密钥打码', async () => {
  render(<AiSettingsSection />);
  expect(await screen.findByText(/接口|命令行/)).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: /DeepSeek|Google|OpenAI/ }));
  expect((screen.getByLabelText(/接口地址/) as HTMLInputElement).value).toMatch(/^https:/);
  expect((screen.getByLabelText(/模型/) as HTMLInputElement).value).toBeTruthy();
});

it('保存时把打码密钥原样带回，服务端才知道没动它', async () => {
  const save = vi.spyOn(api, 'saveAiSettings').mockResolvedValue({} as any);
  // ...填地址/模型、勾 consent、点保存
  expect(save).toHaveBeenCalled();
});
```

- [ ] **Step 2: 实现组件**

要点：

- `mode` Radio：调接口 / 本机命令行。
- 接口：可见预置 chips（默认若干 + 「更多厂商」）；端点 tags（同一家多端点时）；`接口地址`、`模型`、`密钥` 三格；`协议` 只在「自定义」时显示（openai/anthropic/gemini）。
- 切换服务商时保留每家自己的记录（`endpoints[providerKey]`）；密钥跟着记录走。
- `consent` 复选框；文案说清会把档案/笔记/错误发给所选服务。
- 命令行：工具下拉（claude/codex/gemini/agy/custom）、路径、自定义参数；状态文字（已找到/没找到）。
- 「测试连接」：先保存草稿，再调 `/api/ai/test`；显示耗时/错误。
- 打码密钥原样提交；如果用户改了主机，保存前提示「密钥要重填一次」（服务器会清空）。
- 保存成功提示。

`SettingsPage` 在 MW key 卡之后加：

```tsx
<span className="slug">AI 讲解</span>
<AiSettingsSection />
```

- [ ] **Step 3: 跑组件测试**

Run: `npx vitest run web/src/components/AiSettingsSection.test.tsx`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add web/src/components/AiSettingsSection.tsx web/src/components/AiSettingsSection.test.tsx web/src/api.ts web/src/types.ts web/src/pages/SettingsPage.tsx
git commit -m "feat(web): configure AI providers and CLI from the settings page"
```

---

## Task 10: 词条页讲解与笔记编辑器

**Files:**
- Create: `web/src/components/AiCoach.tsx`、`AiCoach.test.tsx`、`NoteEditor.tsx`、`NoteEditor.test.tsx`
- Modify: `web/src/pages/WordPage.tsx`、`web/src/api.ts`、`web/src/types.ts`

**Interfaces:**
- Consumes: `/api/ai/status`、`/api/ai/explain`、`/api/ai/note-draft`、`POST /api/notes`
- Produces: 词条页 `AiCoach`；可编辑笔记草稿

- [ ] **Step 1: 写测试**

```tsx
it('未配置时给设置入口，不出现点下去才失败的按钮', async () => {
  vi.spyOn(api, 'aiStatus').mockResolvedValue({ configured: false, consent: false, mode: 'api', provider: null, reason: '还没选接口' });
  render(<AiCoach text="click" />);
  expect(await screen.findByText(/先接上 AI|设置/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /讲解/ })).toBeNull();
});

it('点讲解显示 markdown、来源和「写成笔记」', async () => {
  vi.spyOn(api, 'aiStatus').mockResolvedValue({ configured: true, consent: true, mode: 'api', provider: '接口·m', reason: null });
  vi.spyOn(api, 'aiExplain').mockResolvedValue({ markdown: '## 结论\n舌尖顶住', sources: [{ id: 'l-vs-n', title: 'l/n' }], provider: '接口·m' });
  render(<AiCoach text="click" />);
  fireEvent.click(await screen.findByRole('button', { name: /AI 讲解/ }));
  expect(await screen.findByText(/舌尖顶住/)).toBeTruthy();
  expect(screen.getByText(/l\/n/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /写成笔记/ })).toBeTruthy();
});
```

- [ ] **Step 2: 实现 `AiCoach.tsx`**

- 挂载时取 `api.aiStatus()`。
- `configured && consent` 才显示「AI 讲解」；否则显示一张卡：说清去设置里接上（接口或命令行）并给 `<Link to="/settings">`。
- 讲解结果用 `react-markdown` + `remark-gfm` 渲染；显示 `provider` 和 `sources`（链接到 `/notes/<id>`）。
- 「写成笔记」调 `api.aiNoteDraft({word})`，成功后打开 `NoteEditor`。
- 「继续问助教」 → `<Link to={`/assistant?word=${encodeURIComponent(text)}`}>`。
- 载入/错误/取消（AbortController）状态。

- [ ] **Step 3: 实现 `NoteEditor.tsx`**

- props: `draft`、`open`、`onClose`、`onSaved`。
- 字段：标题、范围（radio 讲这个音/讲这个词）、取值（tags/逗号分隔）、contrasts（逗号分隔）、正文 textarea + 预览。
- 保存调 `api.saveNote(...)`；400 时把服务端的校验警告原样显示；成功提示并 `onSaved`。
- 表单旁注明：笔记对这台机器的所有使用者可见，只写知识，不写个人诊断。

- [ ] **Step 4: 挂到 WordPage**

在 `<NoteHits ... />` 之后加：

```tsx
<AiCoach text={entry.text} target={entry.words.length > 1 ? undefined : entry.words[0]?.word} />
```

（词典没查到的词不给按钮：`AiCoach` 里按 `found` 判断，或父级传 `enabled={entry.words.every(w=>w.found)}`。）

- [ ] **Step 5: 跑测试**

Run: `npx vitest run web/src/components/AiCoach.test.tsx web/src/components/NoteEditor.test.tsx web/src/pages/WordPage.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add web/src/components/AiCoach.tsx web/src/components/AiCoach.test.tsx web/src/components/NoteEditor.tsx web/src/components/NoteEditor.test.tsx web/src/pages/WordPage.tsx web/src/api.ts web/src/types.ts
git commit -m "feat(web): explain a word and save the explanation as a local note"
```

---

## Task 11: 助教对话

**Files:**
- Create: `server/src/ai/chat.ts`、`server/src/ai/chat.test.ts`、`web/src/pages/AssistantPage.tsx`、`AssistantPage.test.tsx`
- Modify: `server/src/app.ts`、`server/src/app.test.ts`、`web/src/api.ts`、`web/src/types.ts`、`web/src/layout.tsx`、`web/src/App.tsx`

**Interfaces:**
- Produces:
  - `chatFile(dataDir,user)`、`readChat`、`appendChat`、`clearChat`
  - `GET/POST/DELETE /api/ai/chat`
  - `/assistant` 页

- [ ] **Step 1: 写存储测试**

```ts
it('按用户存最近 100 条，清空只清自己', () => {
  const d = mkdtempSync(join(tmpdir(), 'chat-'));
  appendChat(d, '甲', { role: 'user', content: 'hi' });
  appendChat(d, '乙', { role: 'user', content: 'yo' });
  expect(readChat(d, '甲').at(-1)?.content).toBe('hi');
  clearChat(d, '甲');
  expect(readChat(d, '甲')).toEqual([]);
  expect(readChat(d, '乙')).toHaveLength(1);
});
```

- [ ] **Step 2: 实现 `chat.ts`**

```ts
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';

export interface ChatMessage { role: 'user'|'assistant'; content: string; at: string }
const MAX_CHAT = 100;
const fileOf = (dataDir: string, user: string) => join(dataDir, 'users', user, 'ai-chat.json');
const valid = (m: unknown): m is ChatMessage => {
  const x = m as Partial<ChatMessage>;
  return (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string' && typeof x.at === 'string';
};

export function readChat(dataDir: string, user: string): ChatMessage[] {
  const f = fileOf(dataDir, user);
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter(valid).slice(-MAX_CHAT) : [];
  } catch { return []; }
}

export function appendChat(dataDir: string, user: string, m: ChatMessage): ChatMessage[] {
  const next = [...readChat(dataDir, user), m].slice(-MAX_CHAT);
  const f = fileOf(dataDir, user);
  mkdirSync(dirname(f), { recursive: true });
  writeFileAtomic(f, `${JSON.stringify(next, null, 2)}
`);
  return next;
}

export function clearChat(dataDir: string, user: string): void {
  const f = fileOf(dataDir, user);
  mkdirSync(dirname(f), { recursive: true });
  writeFileAtomic(f, '[]
');
}
```

- [ ] **Step 3: 路由**

- `GET /api/ai/chat` → 当前用户历史。
- `POST /api/ai/chat` `{message, word?}`：
  - consent、`tryLock('chat')`、消息非空。
  - 上下文：`buildChatContext(deps, message)`；历史最近 20 条；system = coach + context；user = message。
  - 调 `run`；追加 user + assistant；返回 `{reply, sources, provider}`。
  - 失败不追加 assistant；user 消息也不追加（保持历史干净）。
- `DELETE /api/ai/chat` → 清空当前用户。

- [ ] **Step 4: 页面与导航**

`AssistantPage`：消息列表（assistant 用 markdown）、输入框、发送、清空、来源 chips、未配置提示、CLI 模式说明「每条消息会重新启动一次 AI」。
`layout.tsx` 的「每天做的」组后加一组：

```tsx
{ type: 'group', label: <span className="slug">AI</span>, children: [
  { key: '/assistant', label: navLink('/assistant', 'AI 助教') },
  { key: '/organize', label: navLink('/organize', 'AI 整理') },
] },
```

`App.tsx` 加两条路由。

- [ ] **Step 5: 跑测试**

Run: `npx vitest run server/src/ai/chat.test.ts web/src/pages/AssistantPage.test.tsx`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/ai/chat.ts server/src/ai/chat.test.ts server/src/app.ts server/src/app.test.ts web/src/pages/AssistantPage.tsx web/src/pages/AssistantPage.test.tsx web/src/api.ts web/src/types.ts web/src/layout.tsx web/src/App.tsx
git commit -m "feat(ai): give the tutor a per-user conversation with context"
```

---

## Task 12: 代理运行器（快照、diff、撤销、参考副本）

**Files:**
- Create: `server/src/ai/agent.ts`、`server/src/ai/agent.test.ts`

**Interfaces:**
- Produces:
  - `prepareReference(appRoot, shippedNotes, workflowsDir)`
  - `snapshotAllowed(deps): Snapshot`
  - `diffSnapshots(before, after)`: `{added,modified,removed}`
  - `restoreSnapshot(runDir, deps)`
  - `AgentRunner`：`run(task, note?)`、`status()`、`cancel()`、`undo()`

- [ ] **Step 1: 写测试**

```ts
it('快照 + 假 CLI 写一篇笔记 → diff 有新增；撤销后文件消失', async () => {
  const deps = agentDeps(); // temp appRoot/data；本地笔记空
  const runner = new AgentRunner(deps, { runAgent: async ({ cwd, onLog }) => {
    writeFileSync(join(cwd, 'data', 'notes', 'ai-test.md'), '---\nid: ai-test\ntitle: t\ntriggers: [phoneme:l]\n---\n## 自检法\nx\n## 对比训练\ny\n');
    onLog('wrote note');
    return { code: 0, output: 'done' };
  }});
  await runner.run('organize');
  expect(runner.status().changed?.added).toContain('data/notes/ai-test.md');
  runner.undo();
  expect(existsSync(join(deps.appRoot, 'data', 'notes', 'ai-test.md'))).toBe(false);
});

it('越界改动会被点名', async () => { /* 假 CLI 写 data/当前用户.txt，status().outOfScope 非空 */ });
```

- [ ] **Step 2: 实现 `agent.ts`**

- `prepareReference`：把 `shippedNotes` 复制到 `<appRoot>/.ai-reference/notes`、`workflowsDir` 复制到 `.ai-reference/workflows`；每次运行前刷新（先删后拷，避免旧文件；不影响源）。
- `snapshotAllowed`：读 `profileFile` + 递归 `localNotes`（文件名→内容 hash）；另记 `data/` 下除 `audio/`、`models/`、`ai-runs/` 之外文件的 mtime/hash，用于越界检测。
- `run(task)`：
  - 单飞锁；state `running`；`prepareReference`；`runId = <ISO>-<counter>`；`runDir = data/ai-runs/<runId>`；写 snapshot。
  - `prompt = buildAgentPrompt(deps, taskText, note)`；`inv = resolveCliInvocation(settings, prompt, 'agent')`；`runAgent({cwd: appRoot, onLog})`。
  - 结束后：`noteStore.load()`、`reconcileAttempts`、`syncProfile`；计算 diff（profile + localNotes）；越界检测；`noteStore.warnings` 里与新增/修改文件相关的告警；AUTO 标记成对检查（读 profile，`BEGIN`/`END` 各一次且顺序正确）。
  - state `done`/`error`；保存 changed/outOfScope/warnings/autoOk。
- `cancel()`：杀进程树；state `cancelled`。
- `undo()`：用 runDir 的 snapshot 恢复 profile + localNotes（删新增、还原修改）；`noteStore.load`、`reconcileAttempts`、`syncProfile`；state `undone`。
- `status()`：`{state, logs, startedAt, changed, outOfScope, noteWarnings, autoOk, runId}`。
- 任务文本：`organize` = 按「该补的笔记」整理；`profile` = 更新档案手写两节；`custom` = 用户的话。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run server/src/ai/agent.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add server/src/ai/agent.ts server/src/ai/agent.test.ts
git commit -m "feat(ai): run the agent with snapshots, diffs and undo"
```

---

## Task 13: 代理路由与页面

**Files:**
- Modify: `server/src/app.ts`、`server/src/app.test.ts`、`server/src/index.ts`
- Create: `web/src/pages/OrganizePage.tsx`、`OrganizePage.test.tsx`
- Modify: `web/src/api.ts`、`web/src/types.ts`

**Interfaces:**
- Produces: `POST /api/ai/agent/run`、`GET /api/ai/agent/status`、`POST /api/ai/agent/cancel`、`POST /api/ai/agent/undo`；`/organize` 页

- [ ] **Step 1: 路由与测试**

- 仅在 `settings.mode === 'cli'` 时允许；否则 409 「整理需要命令行代理」。
- consent 闸；`task` 只认 `organize|profile|custom`；custom 必须有 `note`。
- `run` 返回 202 `{runId}`；`status` 返回 runner.status；`cancel`、`undo` 转发。
- AppDeps 加 `agent: AgentRunner`（index 构造；测试注入 fake）。

测试：

```ts
it('接口模式拒绝整理', async () => { /* settings mode api → 409 */ });
it('命令行模式 run/status/undo 转发给 runner', async () => { /* deps.agent fake */ });
```

- [ ] **Step 2: 页面**

`OrganizePage`：

- 首次 `GET /api/ai/status`；API 模式显示「整理需要命令行代理」+ 设置链接。
- 三张任务卡：整理发音记录 / 更新发音档案 / 自定义（textarea）。
- 运行前确认（Modal 列出能改/不能改）。
- 运行后每 1s 轮询 status；显示日志 `<pre>`、已用时、取消。
- 完成后显示 added/modified/removed、越界告警、笔记告警、AUTO 标记状态；「撤销这次整理」。
- 空/错误/运行中状态各自说清。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run server/src/app.test.ts web/src/pages/OrganizePage.test.tsx`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add server/src/app.ts server/src/app.test.ts server/src/index.ts web/src/pages/OrganizePage.tsx web/src/pages/OrganizePage.test.tsx web/src/api.ts web/src/types.ts
git commit -m "feat(ai): run the organizer and show what it changed"
```

---

## Task 14: 文档与最终验证

**Files:**
- Modify: `AGENTS.md`、`README.md`、`.env.example`（如需）
- Maybe modify: `desktop/冒烟清单.md`（AI 设置/代理一页）

- [ ] **Step 1: 更新 AGENTS**

加一节「AI 接入」，写清：

- 设置文件 `data/ai-settings.json`（机器级，不进备份）、密钥打码、换主机清空、密钥非必填。
- 三种协议 + 五个 CLI；接口/命令行分流只在 `runAiText` 一处。
- 上下文来源与判据复用（`noteLinks`/`matchNotes`/`notesCovering`/`articulation`）。
- 笔记写入：本机笔记根、id/文件名安全、三根去重、校验、重扫/重算/同步。
- 代理：cwd、参考副本、可写范围、快照/diff/撤销、越界告警、AUTO 标记。
- consent 闸的范围（设置/状态不挡）。
- 新增依赖 `cross-spawn`/`which` 与打包闭包（`check-package` 会自动覆盖）。

- [ ] **Step 2: 更新 README**

加「AI 讲解」一节：接口模式选服务商、填地址/模型/密钥；命令行模式选 claude/codex/gemini/agy；没有 AI 也能用其余功能；数据会发给所选服务；代理能改哪些文件、怎么撤销。

- [ ] **Step 3: 补充桌面冒烟清单**

加一条：设置 AI（接口/命令行）→ 讲解 → 存笔记 → 对话 → 代理整理 → 撤销。

- [ ] **Step 4: 最终验证**

```bash
npm test
npm run build
npm run check:package
npm run smoke:package
```

再按 `desktop/冒烟清单.md` 在真机上走一遍（GUI 部分）。

- [ ] **Step 5: 提交**

```bash
git add AGENTS.md README.md desktop/冒烟清单.md
git commit -m "docs(ai): document the providers, note drafts and agent boundaries"
```

---

## Self-Review

### 1. Spec coverage

| Spec 章节 | 落点 |
|---|---|
| provider 目录同步、只消费三协议 | Task 1 |
| AI 设置、打码、换主机清钥、consent、密钥非必填 | Task 2、8 |
| 三协议适配、非流式、脱敏、错误映射 | Task 3 |
| CLI 文本/代理参数、cross-spawn、状态、测试 | Task 4、8、9 |
| 安全：Origin/Content-Type、地址只收 http(s) | Task 5、2 |
| 上下文复用现有判据 | Task 6 |
| 提示词正本、笔记草稿、frontmatter、校验、写入 | Task 7 |
| 讲解/存笔记 UI | Task 10 |
| 助教对话、历史、每用户 | Task 11 |
| 代理整理、快照、diff、撤销、越界、AUTO | Task 12、13 |
| 设置 UI / provider 预置 | Task 9 |
| 文档 | Task 14 |
| 不做：流式、API 模式写文件、AI 设置进备份 | 全计划遵守 |

### 2. Placeholder scan

本计划没有 TBD / TODO，也没有留空的函数体；每个任务的代码块都是可落地的形状。

### 3. Type consistency

- `AiSettings` / `AiEndpointRecord` / `AiProtocol` 在 Task 2/3/8 同名同字段。
- `runAiText` 返回 `{text, provider}`；`AiCoach`/chat 都读这个形状。
- `AgentRunner.status()` 的 `changed` 是 `{added,modified,removed}`；页面按它渲染。
- `latestAttemptFor` 的 `atIndex` 与 `attempt_error.at_index` 对齐。
- `WEB_AI_PROTOCOLS` 与 `AI_PROTOCOLS` 都是 `openai|anthropic|gemini`；Task 1 的测试只校验 web 侧，实施时再加一条 server 侧源码扫描（`SUPPORTED_PROTOCOLS` 必须等于这三个）。

### 4. 执行顺序

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14。
Task 8 之前必须有 2/3/4/6/7；Task 9 依赖 1/2/8；Task 10 依赖 8；Task 11/13 依赖 8/12。

---

## 执行交接

计划保存到 `docs/superpowers/plans/2026-10-27-ai-integration.md`。

按你的偏好，建议**在本会话内 inline 执行**，逐 Task 测试并本地提交、不 push；需要独立复核时再单开只读复核。从 **Task 1** 开始。
