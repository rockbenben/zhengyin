import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';

export const AI_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type AiProtocol = typeof AI_PROTOCOLS[number];

export const AI_CLI_KINDS = ['claude', 'codex', 'gemini', 'agy', 'custom'] as const;
export type AiCliKind = typeof AI_CLI_KINDS[number];

/**
 * 推理档位。空串 = 不传这个参数，用命令行工具自己的默认。
 *
 * agy 默认拿的是**带思考**的档：回一句「OK」也要先想一遍，实测要等近十秒。
 * 调低一档只快一两秒（真正的大头是它每次都要重起一遍），但讲解质量会差一点。
 */
export const AI_CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiCliEffort = typeof AI_CLI_EFFORTS[number];

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
  /** effort / model 是空串时**不传**给命令行工具，由它自己决定用哪个。 */
  cli: { kind: AiCliKind; path: string; customArgs: string; effort: string; model: string };
}

const defaults = (): AiSettings => ({
  schemaVersion: 1,
  consent: false,
  mode: 'api',
  endpointId: '',
  endpoints: {},
  cli: { kind: 'claude', path: '', customArgs: '', effort: '', model: '' },
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
const isCliEffort = (v: unknown): v is AiCliEffort =>
  typeof v === 'string' && (AI_CLI_EFFORTS as readonly string[]).includes(v);

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
  // 档位只认那五个（或空串=不传）。写错的档位直接拒绝：它会被原样拼进命令行，
  // 工具报错时用户只会看到一句英文参数错误，压根不知道是这里填错了。
  const effort = typeof cli.effort === 'string' ? cli.effort.trim() : (stored.cli.effort ?? '');
  if (effort !== '' && !isCliEffort(effort)) {
    throw new Error(`推理档位只支持 ${AI_CLI_EFFORTS.join(' / ')}，或者留空用工具自己的默认`);
  }
  const model = typeof cli.model === 'string' ? cli.model.trim() : (stored.cli.model ?? '');
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
      effort,
      model,
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
