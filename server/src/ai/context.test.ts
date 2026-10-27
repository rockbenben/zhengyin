import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logAttempt, openDb, upsertEntry } from '../db.js';
import { analyzeText } from '../service.js';
import { NoteStore } from '../notes.js';
import {
  buildAgentPrompt, buildChatContext, buildWordContext, type AiContextDeps,
} from './context.js';

function fixture(): AiContextDeps {
  const notesDir = mkdtempSync(join(tmpdir(), 'ctx-notes-'));
  writeFileSync(join(notesDir, 'l-vs-n.md'), `---
id: l-vs-n
title: l/n 混淆
triggers: [phoneme:l, phoneme:n]
---
舌尖位置区分 l 和 n。捏住鼻子：发得出声是 l，发不出是 n。
`, 'utf8');
  const noteStore = new NoteStore([{ dir: notesDir, source: 'shipped' }]);
  noteStore.load();

  const profileFile = join(mkdtempSync(join(tmpdir(), 'ctx-profile-')), '发音档案.md');
  writeFileSync(profileFile, '## 已确认的习惯问题\n（还没有）\n', 'utf8');

  const db = openDb(':memory:');
  const words = analyzeText('click');
  upsertEntry(db, 'click', words, 't1');
  logAttempt(db, {
    entryText: 'click', target: 'click', at: '2026-10-27T00:00:00Z',
    targetIpa: words[0].phoneIpa, heardIpa: ['k', 'n', 'ɪ', 'k'],
    clean: false,
    ops: [
      { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
      { kind: 'sub', targetIpa: 'l', heardIpa: 'n' },
      { kind: 'match', targetIpa: 'ɪ', heardIpa: 'ɪ' },
      { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
    ],
  });

  return { db, noteStore, profileFile };
}

describe('buildWordContext', () => {
  it('词上下文包含音标、最近错误、相关笔记与发音要点', () => {
    const ctx = buildWordContext(fixture(), 'click');
    expect(ctx.text).toContain('/ˈklɪk/');
    expect(ctx.text).toContain('k l ɪ k');
    expect(ctx.text).toContain('l→n');
    expect(ctx.text).toContain('舌尖');
    expect(ctx.text).toContain('已确认的习惯问题');
    expect(ctx.sources.map((s) => s.id)).toEqual(['l-vs-n']);
  });

  it('短语词条按这次实际念的词取最近一次录音', () => {
    const deps = fixture();
    const words = analyzeText('black cat');
    upsertEntry(deps.db, 'black cat', words, 't1');
    logAttempt(deps.db, {
      entryText: 'black cat', target: 'black', at: 't1',
      targetIpa: words[0].phoneIpa, heardIpa: words[0].phoneIpa,
      clean: false,
      ops: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b' },
        { kind: 'match', targetIpa: 'l', heardIpa: 'l' },
        { kind: 'sub', targetIpa: 'æ', heardIpa: 'ɛ' },
        { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
      ],
    });
    logAttempt(deps.db, {
      entryText: 'black cat', target: 'cat', at: 't2',
      targetIpa: words[1].phoneIpa, heardIpa: words[1].phoneIpa,
      clean: false,
      ops: [
        { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
        { kind: 'sub', targetIpa: 'æ', heardIpa: 'ɑ' },
        { kind: 'match', targetIpa: 't', heardIpa: 't' },
      ],
    });

    const recent = (ctx: { text: string }) =>
      ctx.text.split('# 最近一次录音\n')[1].split('\n\n#')[0];

    const black = buildWordContext(deps, 'black cat', 'black');
    expect(recent(black)).toContain('æ→ɛ');
    expect(recent(black)).not.toContain('æ→ɑ');

    // 不传 target 时取整条词条最近一次，也就是 cat 那次
    expect(recent(buildWordContext(deps, 'black cat'))).toContain('æ→ɑ');
  });

  it('词库里没有时如实说明，不编造上下文', () => {
    const ctx = buildWordContext(fixture(), 'notaword');
    expect(ctx.text).toContain('词库里没有');
    expect(ctx.sources).toEqual([]);
  });
});

describe('buildChatContext', () => {
  it('认出消息里的词与音素，带出匹配的笔记', () => {
    const ctx = buildChatContext(fixture(), 'click 里的 l 总发成 n，怎么练？');
    expect(ctx.text).toContain('click');
    expect(ctx.text).toContain('l→n');
    expect(ctx.text).toContain('笔记索引');
    expect(ctx.text).toContain('l/n 混淆');
    expect(ctx.sources.map((s) => s.id)).toEqual(['l-vs-n']);
  });
});

describe('buildAgentPrompt', () => {
  it('说明路径与可写范围，并带上任务和补充要求', () => {
    const { db, noteStore, profileFile } = fixture();
    const appRoot = join(tmpdir(), 'app');
    const prompt = buildAgentPrompt({
      db, noteStore, profileFile, appRoot,
      workflowsDir: join(appRoot, 'workflows'), userName: '小明',
    }, '把 l/n 的笔记补好', '别覆盖别人的档案');

    expect(prompt).toContain('小明');
    expect(prompt).toContain(join(appRoot, 'data', 'notes'));
    expect(prompt).toContain(profileFile);
    expect(prompt).toContain('已确认的习惯问题');
    expect(prompt).toContain('把 l/n 的笔记补好');
    expect(prompt).toContain('别覆盖别人的档案');
  });
});
