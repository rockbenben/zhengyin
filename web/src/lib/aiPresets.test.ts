import { describe, it, expect } from 'vitest';
import { AI_PRESETS, findPresetByUrl, modelSuggestionsFor, visibleAiPresets, WEB_AI_PROTOCOLS } from './aiPresets.js';
import { findProvider } from '../vendor/providerCatalog.generated.js';

describe('AI 预置', () => {
  it('目录里必须有 claude / gemini / 一家 openai', () => {
    expect(findProvider('claude')?.protocol).toBe('anthropic');
    expect(findProvider('gemini')?.protocol).toBe('gemini');
    expect(AI_PRESETS.some((p) => p.protocol === 'openai')).toBe(true);
  });

  it('只暴露服务端实现了的协议，且三种都在', () => {
    expect(new Set(AI_PRESETS.map((p) => p.protocol))).toEqual(new Set(WEB_AI_PROTOCOLS));
    for (const p of AI_PRESETS) expect(WEB_AI_PROTOCOLS).toContain(p.protocol);
  });

  it('不展示 gemini-openai（跟原生 Gemini 重复）', () => {
    expect(AI_PRESETS.some((p) => p.catalogKey === 'gemini-openai')).toBe(false);
  });

  it('hidden 的订阅套餐默认藏起来，当前地址命中时留住', () => {
    const hidden = AI_PRESETS.find((p) => p.hidden);
    expect(hidden, '目录里没有 hidden 预置，这条断言失去意义').toBeTruthy();
    expect(visibleAiPresets(false)).not.toContain(hidden);
    expect(visibleAiPresets(false, hidden!.url)).toContain(hidden);
  });

  it('按完整地址或 base 能找到同一个预置', () => {
    const p = AI_PRESETS.find((x) => x.protocol === 'openai')!;
    expect(findPresetByUrl(p.url)?.providerKey).toBe(p.providerKey);
    expect(findPresetByUrl(p.base)?.providerKey).toBe(p.providerKey);
  });

  it('模型候选来自目录；自定义地址没有候选', () => {
    const claude = AI_PRESETS.find((p) => p.catalogKey === 'claude')!;
    expect(modelSuggestionsFor(claude).length).toBeGreaterThan(0);
    const custom = AI_PRESETS.find((p) => p.catalogKey === 'llm');
    if (custom) expect(modelSuggestionsFor(custom)).toEqual([]);
  });
});
