import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiSettings } from './settings.js';
import { AiError } from './protocols.js';
import { aiStatus, readCoach, runAiText } from './run.js';

const settings = (over: Partial<AiSettings> = {}): AiSettings => ({
  schemaVersion: 1,
  consent: true,
  mode: 'api',
  endpointId: 'x',
  endpoints: { x: { protocol: 'openai', baseUrl: 'https://a.test/v1', key: 'sk-1', model: 'm' } },
  cli: { kind: 'claude', path: '', customArgs: '' },
  ...over,
});

describe('runAiText', () => {
  it('接口模式走所选协议，返回正文与提供方', async () => {
    const fetchFn = vi.fn(async (_url: string) => new Response(JSON.stringify({
      choices: [{ message: { content: '把舌尖顶上去。' } }],
    }), { status: 200 }));
    const r = await runAiText(settings(), [{ role: 'user', content: 'click' }], {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r).toEqual({ text: '把舌尖顶上去。', provider: '接口·m' });
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://a.test/v1/chat/completions');
  });

  it('没选接口时 409，而不是静默回空话', async () => {
    await expect(runAiText(settings({ endpointId: '' }), [{ role: 'user', content: 'x' }]))
      .rejects.toMatchObject({ status: 409 });
  });

  it('没填模型时 409', async () => {
    const s = settings({ endpoints: { x: { protocol: 'openai', baseUrl: 'https://a.test/v1', key: '', model: '' } } });
    await expect(runAiText(s, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 409 });
  });
});

describe('aiStatus', () => {
  it('接口已配置', () => {
    expect(aiStatus(settings(), () => false)).toEqual({
      configured: true, mode: 'api', consent: true, provider: 'openai·m', reason: null,
    });
  });

  it('接口缺模型时说明原因', () => {
    const s = settings({ endpoints: { x: { protocol: 'openai', baseUrl: 'https://a.test', key: '', model: '' } } });
    expect(aiStatus(s, () => false)).toMatchObject({ configured: false, reason: '模型名还没填' });
  });

  it('命令行看的是命令在不在 PATH 上', () => {
    const s = settings({ mode: 'cli', cli: { kind: 'claude', path: '', customArgs: '' } });
    expect(aiStatus(s, () => true)).toMatchObject({ configured: true, provider: 'claude', reason: null });
    expect(aiStatus(s, () => false)).toMatchObject({ configured: false, reason: '没找到 claude' });
  });
});

describe('readCoach', () => {
  it('读提示词正本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'coach.md'), '你是发音教练。', 'utf8');
    expect(readCoach(dir)).toContain('发音教练');
    rmSync(dir, { recursive: true, force: true });
  });

  it('缺失时明确报 500，不拿过期副本顶上', () => {
    expect(() => readCoach(join(tmpdir(), 'no-such-workflows'))).toThrow(AiError);
  });
});
