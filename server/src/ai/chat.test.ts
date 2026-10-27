import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChat, chatFile, clearChat, readChat } from './chat.js';

const dir = () => mkdtempSync(join(tmpdir(), 'chat-'));

describe('chat 存储', () => {
  it('按用户存，清空只清自己', () => {
    const d = dir();
    appendChat(d, '甲', { role: 'user', content: 'hi' });
    appendChat(d, '乙', { role: 'user', content: 'yo' });
    expect(readChat(d, '甲').at(-1)?.content).toBe('hi');
    clearChat(d, '甲');
    expect(readChat(d, '甲')).toEqual([]);
    expect(readChat(d, '乙')).toHaveLength(1);
    expect(chatFile(d, '乙')).toContain(join('users', '乙', 'ai-chat.json'));
  });

  it('只留最近 100 条', () => {
    const d = dir();
    for (let i = 0; i < 105; i++) appendChat(d, '甲', { role: 'user', content: `m${i}` });
    const got = readChat(d, '甲');
    expect(got).toHaveLength(100);
    expect(got[0].content).toBe('m5');
    expect(got.at(-1)?.content).toBe('m104');
  });

  it('坏文件与坏条目都不让页面打不开', () => {
    const d = dir();
    const f = chatFile(d, '甲');
    appendChat(d, '甲', { role: 'user', content: 'ok' });
    writeFileSync(f, '{坏了', 'utf8');
    expect(readChat(d, '甲')).toEqual([]);

    writeFileSync(f, JSON.stringify([
      { role: 'user', content: 'ok', at: 't' },
      { role: 'system', content: 'x', at: 't' },
      { role: 'assistant', content: 1, at: 't' },
      null,
    ]), 'utf8');
    expect(readChat(d, '甲')).toEqual([{ role: 'user', content: 'ok', at: 't' }]);
  });

  it('没写 at 的输入补上时间', () => {
    const d = dir();
    const got = appendChat(d, '甲', { role: 'user', content: 'hi' });
    expect(got[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
