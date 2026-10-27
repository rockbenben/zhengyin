import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';

export const AI_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type AiProtocol = typeof AI_PROTOCOLS[number];

export const AI_CLI_KINDS = ['claude', 'codex', 'gemini', 'agy', 'custom'] as const;
export type AiCliKind = typeof AI_CLI_KINDS[number];

export type AiMode = 'api' | 'cli';

export interface AiEndpointRecord {
  protocol: AiProtocol;
  baseUrl: string;
  key: string;
  model: string;
}

export interface AiSettings {
  schemaVersion: 1;
  consent: boolean;
  mode: AiMode;
  endpointId: string;
  endpoints: Record<string, AiEndpointRecord>;
  cli: { kind: AiCliKind; path: string; customArgs: string };
}

const defaults = (): AiSettings => ({
  schemaVersion: 1,
  consent: false,
  mode: 'api',
  endpointId: '',
  endpoints: {},
  cli: { kind: 'claude', path: '', customArgs: '' },
});

const fileOf = (dataDir: string): string => join(dataDir, 'ai-settings.json');
const mask = (key: string): string => (key.length <= 4 ? '••••' : `••••${key.slice(-4)}`);

export function maskAiSettings(s: AiSettings): AiSettings {
  const endpoints: Record<string, AiEndpointRecord> = {};
  for (const [id, r] of Object.entries(s.endpoints)) {
    endpoints[id] = { ...r, key: r.key ? mask(r.key) : '' };
  }
  return { ...s, endpoints };
}

const isProtocol = (v: unknown): v is AiProtocol =>
  typeof v === 'string' && (AI_PROTOCOLS as readonly string[]).includes(v);
const isCliKind = (v: unknown): v is AiCliKind =>
  typeof v === 'string' && (AI_CLI_KINDS as readonly string[]).includes(v);

function sanitizeEndpoint(raw: unknown, stored: AiEndpointRecord | undefined): AiEndpointRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : '';
  if (!baseUrl) return null;

  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new Error('AI 接口地址不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('AI 接口地址只接受 http / https');
  }
  if (!isProtocol(r.protocol)) {
    throw new Error('AI 协议只支持 openai / anthropic / gemini');
  }

  const model = typeof r.model === 'string' ? r.model.trim() : '';
  const prev = stored?.key ?? '';
  const incoming = typeof r.key === 'string' ? r.key.trim() : '';
  const untouched = incoming === '' || (!!prev && incoming === mask(prev));
  let hostMoved = false;
  if (stored?.baseUrl) {
    try { hostMoved = new URL(stored.baseUrl).host !== u.host; } catch { hostMoved = false; }
  }
  return { protocol: r.protocol, baseUrl, model, key: untouched ? (hostMoved ? '' : prev) : incoming };
}

export function mergeAiSettings(body: unknown, stored: AiSettings): AiSettings {
  const b = (body ?? {}) as Partial<AiSettings>;
  const gave = Boolean(b.endpoints && typeof b.endpoints === 'object');
  const rawEndpoints = (gave ? b.endpoints : stored.endpoints) as Record<string, unknown>;
  const endpoints: Record<string, AiEndpointRecord> = {};
  for (const [id, raw] of Object.entries(rawEndpoints)) {
    // 客户端挑的键；这三个名字能把 table[id] 变成改原型
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    const rec = sanitizeEndpoint(raw, stored.endpoints[id]);
    if (rec) endpoints[id] = rec;
  }

  const requested = typeof b.endpointId === 'string' ? b.endpointId : undefined;
  const endpointId = requested !== undefined && Object.hasOwn(endpoints, requested)
    ? requested
    : requested === '' && Object.hasOwn(endpoints, stored.endpointId)
      ? stored.endpointId
      : gave ? '' : (Object.hasOwn(endpoints, stored.endpointId) ? stored.endpointId : '');

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
  if (!existsSync(f)) return defaults();
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    return mergeAiSettings(raw, defaults());
  } catch (e) {
    console.warn(`[ai] 读不懂 ${f}，先按未配置处理：${(e as Error).message}`);
    return defaults();
  }
}

export function writeAiSettings(dataDir: string, s: AiSettings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(fileOf(dataDir), `${JSON.stringify(s, null, 2)}\n`);
}

export function activeAi(s: AiSettings): AiEndpointRecord | null {
  return s.endpoints[s.endpointId] ?? null;
}
