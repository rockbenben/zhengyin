import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeAi, type AiSettings } from './settings.js';
import { AiError, callAi, type AiMessage } from './protocols.js';
import { resolveCliInvocation, runCliText } from './cli.js';

export interface AiRunResult { text: string; provider: string }

/** 接口和命令行两条路对调用方是同一个函数，路由不用各写一份。 */
export async function runAiText(
  settings: AiSettings,
  messages: AiMessage[],
  opts: { timeoutMs?: number; cwd?: string; fetchFn?: typeof fetch } = {},
): Promise<AiRunResult> {
  if (settings.mode === 'cli') {
    const prompt = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
    const inv = resolveCliInvocation(settings, prompt, 'text');
    const text = await runCliText(inv, {
      timeoutMs: opts.timeoutMs ?? 180_000,
      cwd: opts.cwd,
      kind: settings.cli.kind,
    });
    return { text, provider: `命令行·${inv.displayName}` };
  }

  const rec = activeAi(settings);
  if (!rec) throw new AiError(409, '还没选 AI 接口。去设置里选一家、填地址和模型。');
  if (!rec.model.trim()) throw new AiError(409, '设置里的 AI 模型名还没填。');
  const text = await callAi(rec, messages, { timeoutMs: opts.timeoutMs, fetchFn: opts.fetchFn });
  return { text, provider: `接口·${rec.model}` };
}

export function aiStatus(settings: AiSettings, commandExists: (c: string) => boolean): {
  configured: boolean;
  mode: 'api' | 'cli';
  consent: boolean;
  provider: string | null;
  reason: string | null;
} {
  if (settings.mode === 'cli') {
    const inv = resolveCliInvocation(settings, '', 'text');
    const ok = commandExists(inv.command);
    return {
      configured: ok, mode: 'cli', consent: settings.consent,
      provider: inv.displayName,
      reason: ok ? null : `没找到 ${inv.displayName}`,
    };
  }
  const rec = activeAi(settings);
  if (!rec) return { configured: false, mode: 'api', consent: settings.consent, provider: null, reason: '还没选接口' };
  if (!rec.baseUrl.trim()) {
    return { configured: false, mode: 'api', consent: settings.consent, provider: rec.model || null, reason: '接口地址还没填' };
  }
  if (!rec.model.trim()) {
    return { configured: false, mode: 'api', consent: settings.consent, provider: null, reason: '模型名还没填' };
  }
  return {
    configured: true, mode: 'api', consent: settings.consent,
    provider: `${rec.protocol}·${rec.model}`, reason: null,
  };
}

/** 提示词正本在 workflows/ 里；缺了是安装坏了，不能静默用一段过期副本顶上。 */
export function readWorkflow(workflowsDir: string, file: string): string {
  const path = join(workflowsDir, file);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new AiError(500, `提示词文件缺失：${path}。重装应用，或把这个文件补回来。`);
  }
}

export const readCoach = (workflowsDir: string): string => readWorkflow(workflowsDir, 'coach.md');
