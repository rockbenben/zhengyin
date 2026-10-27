import { PROVIDER_CATALOG, type CatalogProvider } from '../vendor/providerCatalog.generated.js';

export const WEB_AI_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type WebAiProtocol = typeof WEB_AI_PROTOCOLS[number];

export interface AiPreset {
  label: string;
  /** 完整请求地址 */
  url: string;
  /** 去掉动作路径的 base */
  base: string;
  /** 设置里这条记录用的键（目录 provider key，或 custom:<地址>） */
  providerKey: string;
  /** 目录里的 provider key，用来查模型候选 */
  catalogKey: string;
  protocol: WebAiProtocol;
  model: string;
  models: readonly string[];
  hidden?: true;
}

const DISPLAY: Record<string, string> = {
  siliconflow: '硅基流动',
  volcengine: '字节方舟 Coding Plan',
  alibaba: '阿里百炼 Token Plan',
};

/** 上游为「只讲 Chat Completions 的消费方」合成的 OpenAI 兼容面；本仓有原生 Gemini */
const SKIP = new Set(['gemini-openai']);
const isLocal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url);

const supported = (p: CatalogProvider): p is CatalogProvider & { protocol: WebAiProtocol } =>
  (WEB_AI_PROTOCOLS as readonly string[]).includes(p.protocol) && p.endpoints.length > 0;

function preset(label: string, provider: CatalogProvider, endpoint: CatalogProvider['endpoints'][number], providerKey: string): AiPreset {
  return {
    label: isLocal(endpoint.url) ? `${label}（本机）` : label,
    url: endpoint.url,
    base: endpoint.baseUrl,
    providerKey,
    catalogKey: provider.key,
    protocol: provider.protocol as WebAiProtocol,
    model: provider.models.length === 0 ? '' : (provider.defaultModel ?? ''),
    models: provider.models.map((m) => m.id),
    ...(provider.hidden ? { hidden: true as const } : {}),
  };
}

/**
 * 服务商预置。一家一条记录；同一家的地域端点放在这条记录里当地址候选。
 * 例外：端点自己带 docs 的（目录里 `llm` 那组本机运行时）每一个都是独立产品，
 * 各自建一条记录，键用 `custom:<地址>`。
 */
export const AI_PRESETS: readonly AiPreset[] = PROVIDER_CATALOG
  .filter((p) => !SKIP.has(p.key) && supported(p))
  .flatMap((p) => {
    if (p.endpoints.length > 1 && p.endpoints.every((e) => !!e.docs)) {
      return p.endpoints.map((e) => preset(e.label, p, e, `custom:${e.url}`));
    }
    return [preset(DISPLAY[p.key] ?? p.label, p, p.endpoints[0]!, p.key)];
  });

export function visibleAiPresets(showHidden: boolean, currentUrl?: string): readonly AiPreset[] {
  if (showHidden) return AI_PRESETS;
  return AI_PRESETS.filter((p) => !p.hidden || (currentUrl !== undefined && p.url === currentUrl));
}

const norm = (url: string) => url.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/i, '');

export function findPresetByUrl(url: string): AiPreset | undefined {
  const u = norm(url);
  if (!u) return undefined;
  return AI_PRESETS.find((p) => norm(p.url) === u || norm(p.base) === u);
}

export function modelSuggestionsFor(preset: AiPreset | undefined): readonly string[] {
  return preset ? preset.models : [];
}
