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
    const [url, init] = (fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('https://a.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');
  });

  it('anthropic：base 是 /v1 时只补 /messages，不叠成 /v1/v1', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'ok' }],
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await callAi(cfg('anthropic', 'https://api.anthropic.com/v1'), msg, { fetchFn })).toBe('ok');
    const [url, init] = (fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-1');
  });

  it('gemini：base 可带 /v1beta/models，取 candidates parts', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    }), { status: 200 })) as unknown as typeof fetch;
    expect(await callAi(cfg('gemini', 'https://generativelanguage.googleapis.com/v1beta/models'), msg, { fetchFn })).toBe('ok');
    const [url] = (fetchFn as unknown as { mock: { calls: Array<[string]> } }).mock.calls[0]!;
    expect(url).toContain('/v1beta/models/m1:generateContent');
    expect(url).toContain('key=sk-1');
  });

  it('错误映射 + 脱敏', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(callAi(cfg('openai', 'https://a.test/v1'), msg, { fetchFn })).rejects.toMatchObject({ status: 401 });
    expect(redactUrl('https://x/y?key=secret&a=1')).not.toContain('secret');
  });
});
