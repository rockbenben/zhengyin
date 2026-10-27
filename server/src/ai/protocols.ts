export const SUPPORTED_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const;
export type AiProtocol = typeof SUPPORTED_PROTOCOLS[number];

export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AiConfig { protocol: AiProtocol; baseUrl: string; key: string; model: string }

export class AiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AiError';
  }
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of ['key', 'api_key', 'api-key', 'token']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return raw.replace(/([?&](?:key|api_key|api-key|token)=)[^&]*/gi, '$1***');
  }
}

const trimSlash = (s: string): string => s.trim().replace(/\/+$/, '');

/** 认完整动作地址 / 版本路径 / 光域名三种填法 */
const chatUrl = (base: string): string => {
  const u = trimSlash(base);
  if (u.endsWith('/chat/completions')) return u;
  const path = u.replace(/^https?:\/\/[^/]+/i, '');
  return path === '' ? `${u}/v1/chat/completions` : `${u}/chat/completions`;
};

const messagesUrl = (base: string): string => {
  const u = trimSlash(base);
  if (u.endsWith('/messages')) return u;
  if (/\/v1$/i.test(u)) return `${u}/messages`;
  return `${u}/v1/messages`;
};

const systemOf = (messages: AiMessage[]): string =>
  messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

const turns = (messages: AiMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> =>
  messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

async function parseError(res: Response, url: string): Promise<AiError> {
  let detail = '';
  try {
    const b = await res.json() as Record<string, unknown>;
    const err = b.error as { message?: unknown } | undefined;
    detail = typeof err?.message === 'string' ? err.message : typeof b.message === 'string' ? b.message : '';
  } catch {
    detail = await res.text().catch(() => '');
  }
  const status = res.status;
  const zh = status === 401 || status === 403 ? '密钥被拒绝'
    : status === 404 ? '地址路径不对'
      : status === 429 ? '请求太频繁或额度用尽'
        : status >= 500 ? '服务商故障'
          : '请求失败';
  return new AiError(status, `${zh}（${status}）：${redactUrl(url)}${detail ? `\n${detail.slice(0, 300)}` : ''}`);
}

/**
 * 三协议共用的一次非流式调用。不发温度/思考参数：档位是各家的私事，
 * 这一版只要求「给我一段能读的文字」。
 */
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
    let url: string;
    let headers: Record<string, string>;
    let body: unknown;

    if (config.protocol === 'openai') {
      url = chatUrl(config.baseUrl);
      headers = {
        'content-type': 'application/json',
        ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
      };
      body = { model: config.model, messages, max_tokens: maxTokens };
    } else if (config.protocol === 'anthropic') {
      url = messagesUrl(config.baseUrl);
      headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(config.key ? { 'x-api-key': config.key } : {}),
      };
      body = {
        model: config.model,
        max_tokens: maxTokens,
        system: systemOf(messages),
        messages: turns(messages),
      };
    } else {
      const base = trimSlash(config.baseUrl).replace(/\/models$/i, '');
      url = `${base}/models/${encodeURIComponent(config.model)}:generateContent${config.key ? `?key=${encodeURIComponent(config.key)}` : ''}`;
      headers = { 'content-type': 'application/json' };
      body = {
        ...(systemOf(messages) ? { systemInstruction: { parts: [{ text: systemOf(messages) }] } } : {}),
        contents: turns(messages).map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
      };
    }

    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw await parseError(res, url);

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      content?: Array<{ type?: string; text?: string }>;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = config.protocol === 'openai'
      ? (typeof data.choices?.[0]?.message?.content === 'string'
        ? data.choices[0]!.message!.content as string
        : Array.isArray(data.choices?.[0]?.message?.content)
          ? (data.choices[0]!.message!.content as Array<{ text?: string }>).map((p) => p?.text ?? '').join('')
          : '')
      : config.protocol === 'anthropic'
        ? (data.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
        : (data.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('');

    if (!text.trim()) throw new AiError(502, 'AI 返回了空内容（可能被安全策略拦了）。');
    return text;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as { name?: string }).name === 'AbortError') {
      throw new AiError(504, `AI 超过 ${Math.round(timeoutMs / 1000)}s 没有返回。`);
    }
    throw new AiError(502, `连不上 AI 服务：${redactUrl(config.baseUrl)}（${(e as Error).message}）`);
  } finally {
    clearTimeout(timer);
  }
}
