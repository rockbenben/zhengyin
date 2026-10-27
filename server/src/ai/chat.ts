import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';

export interface ChatMessage { role: 'user' | 'assistant'; content: string; at: string }
export type ChatInput = Omit<ChatMessage, 'at'> & { at?: string };

/** 只留最近 100 条：这是对话，不是档案；再长对上下文窗口也没有用。 */
const MAX_CHAT = 100;

export const chatFile = (dataDir: string, user: string): string =>
  join(dataDir, 'users', user, 'ai-chat.json');

const valid = (m: unknown): m is ChatMessage => {
  const x = m as Partial<ChatMessage>;
  return (x?.role === 'user' || x?.role === 'assistant')
    && typeof x.content === 'string'
    && typeof x.at === 'string';
};

export function readChat(dataDir: string, user: string): ChatMessage[] {
  const f = chatFile(dataDir, user);
  if (!existsSync(f)) return [];
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter(valid).slice(-MAX_CHAT) : [];
  } catch {
    // 读不懂就当空历史：它只是对话缓存，不值得让整页打不开。
    return [];
  }
}

export function appendChat(dataDir: string, user: string, m: ChatInput): ChatMessage[] {
  const next = [...readChat(dataDir, user), { ...m, at: m.at ?? new Date().toISOString() }]
    .slice(-MAX_CHAT);
  const f = chatFile(dataDir, user);
  mkdirSync(dirname(f), { recursive: true });
  writeFileAtomic(f, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function clearChat(dataDir: string, user: string): void {
  const f = chatFile(dataDir, user);
  mkdirSync(dirname(f), { recursive: true });
  writeFileAtomic(f, '[]\n');
}
