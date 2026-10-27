import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AI_CLI_KINDS, AI_PROTOCOLS, activeAi, maskAiSettings, mergeAiSettings, readAiSettings, writeAiSettings,
  type AiSettings,
} from './settings.js';

const dir = () => mkdtempSync(join(tmpdir(), 'ai-set-'));
const stored = (): AiSettings => ({
  schemaVersion: 1,
  consent: true,
  mode: 'api',
  endpointId: 'deepseek',
  endpoints: {
    deepseek: { protocol: 'openai', baseUrl: 'https://a.test/v1', key: 'sk-12345678', model: 'm' },
  },
  cli: { kind: 'claude', path: '', customArgs: '' },
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
    const same = mergeAiSettings({
      ...s,
      endpoints: { deepseek: { ...s.endpoints.deepseek, key: '••••5678' } },
    }, s);
    expect(same.endpoints.deepseek!.key).toBe('sk-12345678');

    const moved = mergeAiSettings({
      ...s,
      endpoints: { deepseek: { ...s.endpoints.deepseek, baseUrl: 'https://b.test/v1', key: '••••5678' } },
    }, s);
    expect(moved.endpoints.deepseek!.key).toBe('');
  });

  it('空地址的记录被丢弃；非法协议直接拒绝', () => {
    const dropped = mergeAiSettings({
      ...stored(),
      endpointId: 'y',
      endpoints: { y: { protocol: 'openai', baseUrl: '   ', key: '', model: 'm' } },
    }, stored());
    expect(dropped.endpoints.y).toBeUndefined();

    expect(() => mergeAiSettings({
      ...stored(),
      endpoints: { x: { protocol: 'yandex', baseUrl: 'https://x.test', key: '', model: 'm' } },
    }, stored())).toThrow(/协议/);
  });

  it('地址只接受 http/https', () => {
    expect(() => mergeAiSettings({
      ...stored(),
      endpoints: { deepseek: { ...stored().endpoints.deepseek, baseUrl: 'file:///x' } },
    }, stored())).toThrow(/http/);
  });

  it('只认三种协议与五种 CLI', () => {
    expect(AI_PROTOCOLS).toEqual(['openai', 'anthropic', 'gemini']);
    expect(AI_CLI_KINDS).toEqual(['claude', 'codex', 'gemini', 'agy', 'custom']);
    expect(activeAi(stored())?.model).toBe('m');
  });

  it('选中一条不存在的记录就等于没选', () => {
    const s = mergeAiSettings({ ...stored(), endpointId: 'nope' }, stored());
    expect(s.endpointId).toBe('');
  });
});
