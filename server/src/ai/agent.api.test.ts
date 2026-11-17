import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner, type AgentDeps } from './agent.js';
import { mergeAiSettings, readAiSettings, writeAiSettings } from './settings.js';
import { NoteStore } from '../notes.js';
import { openDb } from '../db.js';
import { syncProfile } from '../profile.js';
import * as atomic from '../atomic.js';

const note = { title: '边音练习', triggers: ['phoneme:l'], words: [], contrasts: [],
  body: '## 自检法\n舌尖抵住上齿龈，让气流从舌头两侧通过。\n## 对比训练\n先比较中文老和脑，再练 light / night。' };
const plan = (notes: unknown[] = [], profile?: unknown) => JSON.stringify({ notes, ...(profile ? { profile } : {}), summary: '整理完成' });
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(): AgentDeps {
  const root = mkdtempSync(join(tmpdir(), 'api-organize-'));
  const localNotes = join(root, 'data/notes'), shippedNotes = join(root, 'shipped'), workflowsDir = join(root, 'workflows');
  for (const dir of [localNotes, shippedNotes, workflowsDir]) mkdirSync(dir, { recursive: true });
  for (const file of ['agent.md', 'agent-api.md']) writeFileSync(join(workflowsDir, file), readFileSync(join(import.meta.dirname, '../../../workflows', file)));
  const profileFile = join(root, 'data/profile.md');
  writeFileSync(profileFile, '# 档案\n## 基本设定\n保留设定\n## 已确认的习惯问题\n原确认\n## 待观察\n原观察\n');
  const db = openDb(':memory:');
  const noteStore = new NoteStore([{ dir: shippedNotes, source: 'shipped' }, { dir: localNotes, source: 'local' }]);
  noteStore.load(); syncProfile(profileFile, db, noteStore, 't0');
  const deps = { appRoot: root, dataDir: join(root, 'data'), localNotes, shippedNotes, workflowsDir, db, noteStore,
    profileFile, userName: () => '合成测试', now: () => 't0' };
  writeAiSettings(deps.dataDir, mergeAiSettings({ mode: 'api', consent: true, endpointId: 'test',
    endpoints: { test: { protocol: 'openai', baseUrl: 'http://127.0.0.1:1', key: '', model: 'fixture' } } }, readAiSettings(deps.dataDir)));
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return deps;
}

it.each(['openai', 'anthropic', 'gemini'] as const)('%s transports a plan over HTTP, saves it and undoes it', async protocol => {
  const deps = fixture(); let requestBody = '', requestPath = '';
  const raw = plan([{ file: 'lesson.md', note }], { watching: '待观察内容' });
  const server = createServer(async (req, res) => {
    requestPath = req.url!; for await (const chunk of req) requestBody += chunk;
    const response = protocol === 'openai' ? { choices: [{ message: { content: raw } }] }
      : protocol === 'anthropic' ? { content: [{ type: 'text', text: raw }] }
      : { candidates: [{ content: { parts: [{ text: raw }] } }] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    writeAiSettings(deps.dataDir, mergeAiSettings({ consent: true, endpointId: 'test', endpoints: { test: { protocol,
      baseUrl: `http://127.0.0.1:${address.port}`, key: '', model: 'fixture' } } }, readAiSettings(deps.dataDir)));
    const runner = new AgentRunner(deps);
    await runner.run('custom', '整理测试笔记');
    expect(runner.status().state, runner.status().error ?? '').toBe('done');
    expect(requestPath).toContain(protocol === 'openai' ? '/v1/chat/completions' : protocol === 'anthropic' ? '/v1/messages' : ':generateContent');
    expect(requestBody).toContain('整理测试笔记');
    expect(existsSync(join(deps.dataDir, 'ai-runs', runner.status().runId!, 'workspace', '.ai-reference'))).toBe(false);
    expect(requestBody).toContain('原观察');
    expect(requestBody).not.toContain('ai-settings.json');
    const saved = join(deps.localNotes, 'lesson.md');
    expect(readFileSync(saved, 'utf8')).toContain('id: ai-lesson');
    expect(readFileSync(deps.profileFile, 'utf8')).toContain('待观察内容');
    expect(readFileSync(deps.profileFile, 'utf8')).toContain('保留设定');
    runner.undo();
    expect(existsSync(saved)).toBe(false);
    expect(readFileSync(deps.profileFile, 'utf8')).toContain('原观察');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each([
  'not JSON',
  plan([{ file: '../escape.md', note }]),
  plan([{ file: 'C:\\escape.md', note }]),
  plan([{ file: 'CON.md', note }]),
  plan([{ file: 'okay.md', note }, { file: 'bad.md', note: { ...note, body: '缺少必需章节' } }]),
  plan([{ file: 'lesson.md', note }, { file: 'lesson.md', note }]),
  plan([{ file: 'lesson.md', note: { ...note, command: 'ignored?' } }]),
  plan([], { watching: '## 基本设定\n非法修改' }),
  plan([], { watching: '<!-- AUTO:发音统计 -->' }),
  plan([], { other: '非法章节' }),
  plan([{ file: 'missing.md', note: null }]),
])('rejects malformed or out-of-scope plans without changing live files (%#)', async raw => {
  const deps = fixture(), before = readFileSync(deps.profileFile, 'utf8');
  const runner = new AgentRunner(deps, { runText: async () => ({ text: raw, provider: 'fixture' }) });
  await runner.run('organize');
  expect(runner.status().state).toBe('error');
  expect(existsSync(join(deps.localNotes, 'okay.md'))).toBe(false);
  expect(existsSync(join(deps.localNotes, 'lesson.md'))).toBe(false);
  expect(existsSync(join(deps.appRoot, 'escape.md'))).toBe(false);
  expect(readFileSync(deps.profileFile, 'utf8')).toBe(before);
});

it('preserves concurrent edits and never applies a partially valid batch', async () => {
  const deps = fixture();
  const file = join(deps.localNotes, 'old.md');
  writeFileSync(file, '---\nid: original\ntitle: 原笔记\ntriggers: [phoneme:l]\n---\n'+note.body);
  const runner = new AgentRunner(deps, { runText: async () => {
    writeFileSync(file, readFileSync(file, 'utf8').replace('原笔记', '用户后续编辑'));
    return { text: plan([{ file: 'new.md', note }, { file: 'old.md', note }]), provider: 'fixture' };
  } });
  await runner.run('organize');
  expect(runner.status().error).toContain('保留原件');
  expect(existsSync(join(deps.localNotes, 'new.md'))).toBe(false);
  expect(readFileSync(file, 'utf8')).toContain('用户后续编辑');
  runner.undo();
  expect(readFileSync(file, 'utf8')).toContain('用户后续编辑');
});

it('cancels a pending plan, aborts its request and ignores a late response', async () => {
  const deps = fixture(), before = readFileSync(deps.profileFile, 'utf8');
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let signal: AbortSignal | undefined;
  const runner = new AgentRunner(deps, { runText: async (_s, _m, opts) => {
    signal = opts?.signal; await gate;
    return { text: plan([{ file: 'lesson.md', note }]), provider: 'fixture' };
  } });
  const pending = runner.run('organize');
  runner.cancel(); expect(signal?.aborted).toBe(true); release(); await pending;
  expect(runner.status().state).toBe('cancelled');
  expect(existsSync(join(deps.localNotes, 'lesson.md'))).toBe(false);
  expect(readFileSync(deps.profileFile, 'utf8')).toBe(before);
});

it('rejects an unconsented request before building a snapshot', async () => {
  const deps = fixture(); const runText = vi.fn();
  writeAiSettings(deps.dataDir, { ...readAiSettings(deps.dataDir), consent: false });
  const runner = new AgentRunner(deps, { runText });
  await runner.run('organize');
  expect(runner.status().state).toBe('error');
  expect(runner.status().runId).toBeNull();
  expect(runText).not.toHaveBeenCalled();
});

it('updates and deletes existing local notes, preserves IDs and restores both on undo', async () => {
  const deps = fixture();
  const original = '---\r\nid: stable-id\r\ntitle: 原笔记\r\ntriggers: [phoneme:l]\r\n---\r\n'+note.body;
  const updated = join(deps.localNotes, '中文笔记.md'), deleted = join(deps.localNotes, 'delete.md');
  writeFileSync(updated, original); writeFileSync(deleted, original.replace('stable-id', 'delete-id'));
  const runner = new AgentRunner(deps, { runText: async () => ({ provider: 'fixture', text:
    plan([{ file: '中文笔记.md', note }, { file: 'delete.md', note: null }]) }) });
  await runner.run('organize');
  expect(runner.status().state, runner.status().error ?? '').toBe('done');
  expect(readFileSync(updated, 'utf8')).toContain('id: stable-id');
  expect(existsSync(deleted)).toBe(false);
  runner.undo();
  expect(readFileSync(updated, 'utf8')).toBe(original);
  expect(readFileSync(deleted, 'utf8')).toBe(original.replace('stable-id', 'delete-id'));
});

it('preserves concurrent profile edits and rejects the entire proposed batch', async () => {
  const deps = fixture();
  const runner = new AgentRunner(deps, { runText: async () => {
    writeFileSync(deps.profileFile, readFileSync(deps.profileFile, 'utf8').replace('原观察', '用户修改'));
    return { text: plan([{ file: 'lesson.md', note }], { watching: '模型修改' }), provider: 'fixture' };
  } });
  await runner.run('profile');
  expect(runner.status().error).toContain('小节已被修改');
  expect(readFileSync(deps.profileFile, 'utf8')).toContain('用户修改');
  expect(existsSync(join(deps.localNotes, 'lesson.md'))).toBe(false);
});

it('undo restores only AI-edited sections and preserves concurrent and later edits', async () => {
  const deps = fixture();
  const edit = (from: string, to: string) =>
    writeFileSync(deps.profileFile, readFileSync(deps.profileFile, 'utf8').replace(from, to));
  const runner = new AgentRunner(deps, { runText: async () => {
    edit('保留设定', '人工同期编辑');
    return { text: plan([], { confirmed: '模型确认', watching: '模型观察' }), provider: 'fixture' };
  } });
  await runner.run('profile');
  expect(runner.status().state).toBe('done');
  edit('模型观察', '人工后续编辑');
  runner.undo();
  const result = readFileSync(deps.profileFile, 'utf8');
  expect(result).toContain('人工同期编辑');
  expect(result).toContain('人工后续编辑');
  expect(result).toContain('原确认');
  expect(result).not.toContain('模型确认');
  expect(runner.status().noteWarnings).toContain('保留档案的后续编辑：待观察');
});

it('sends only parsed top-level Markdown notes and preserves other local files', async () => {
  const deps = fixture();
  const nested = join(deps.localNotes, 'drafts');
  mkdirSync(nested);
  const backup = join(deps.localNotes, 'old.bak');
  writeFileSync(backup, 'BACKUP_SENTINEL');
  writeFileSync(join(nested, 'draft.md'), 'DRAFT_SENTINEL');
  writeFileSync(join(deps.localNotes, 'existing.md'),
    '---\nid: existing\ntitle: 已有笔记\ntriggers: [phoneme:l]\nextra: METADATA_SENTINEL\n---\n' + note.body);
  const runText = vi.fn(async () => ({ provider: 'fixture', text: plan([{ file: 'new.md', note }]) }));
  const runner = new AgentRunner(deps, { runText });
  await runner.run('organize');
  expect(runner.status().state, runner.status().error ?? '').toBe('done');
  const payload = JSON.stringify(runText.mock.calls);
  expect(payload).toContain('existing.md');
  expect(payload).not.toMatch(/old\.bak|draft\.md|BACKUP_SENTINEL|DRAFT_SENTINEL|METADATA_SENTINEL/);
  expect(readFileSync(backup, 'utf8')).toBe('BACKUP_SENTINEL');
  expect(readFileSync(join(nested, 'draft.md'), 'utf8')).toBe('DRAFT_SENTINEL');
  expect(existsSync(join(deps.localNotes, 'new.md'))).toBe(true);
});

it('undo preserves duplicated manual sections and restores the other section and notes', async () => {
  const deps = fixture();
  const runner = new AgentRunner(deps, { runText: async () => ({
    text: plan([{ file: 'lesson.md', note }], { confirmed: '模型确认', watching: '模型观察' }),
    provider: 'fixture',
  }) });
  await runner.run('organize');
  expect(runner.status().state).toBe('done');
  const current = readFileSync(deps.profileFile, 'utf8');
  writeFileSync(deps.profileFile, current.replace('## 待观察', '## 待观察\n用户补记\n\n## 待观察'));
  runner.undo();
  const restored = readFileSync(deps.profileFile, 'utf8');
  expect(restored).toContain('原确认');
  expect(restored).toContain('用户补记');
  expect(restored).toContain('模型观察');
  expect(existsSync(join(deps.localNotes, 'lesson.md'))).toBe(false);
  expect(runner.status().state).toBe('undone');
  expect(runner.status().noteWarnings).toContain('保留档案的后续编辑：待观察');
});

it('new notes cannot shadow an existing reference ID', async () => {
  const deps = fixture();
  const reference = join(deps.shippedNotes, 'reference.md');
  const original = '---\nid: ai-lesson\ntitle: 随附笔记\ntriggers: [phoneme:l]\n---\n'+note.body;
  writeFileSync(reference, original); deps.noteStore.load();
  const runner = new AgentRunner(deps, { runText: async () => ({ text: plan([{ file: 'lesson.md', note }]), provider: 'fixture' }) });
  await runner.run('organize');
  expect(runner.status().state, runner.status().error ?? '').toBe('done');
  expect(readFileSync(join(deps.localNotes, 'lesson.md'), 'utf8')).toContain('id: ai-lesson-2');
  expect(readFileSync(reference, 'utf8')).toBe(original);
  expect(deps.noteStore.get('ai-lesson')?.source).toBe('shipped');
});

it('records partial disk-write failures and undoes only the files actually submitted', async () => {
  const deps = fixture(), first = join(deps.localNotes, 'first.md'), second = join(deps.localNotes, 'second.md');
  const write = atomic.writeFileAtomic;
  vi.spyOn(atomic, 'writeFileAtomic').mockImplementation((file, content) => {
    if (file === second) throw new Error('synthetic disk write failed');
    write(file, content);
  });
  const runner = new AgentRunner(deps, { runText: async () => ({ provider: 'fixture', text:
    plan([{ file: 'first.md', note }, { file: 'second.md', note }]) }) });
  await runner.run('organize');
  expect(runner.status().state).toBe('error');
  expect(runner.status().error).toContain('disk write failed');
  expect(runner.status().changed?.added).toContain('data/notes/first.md');
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(false);
  runner.undo();
  expect(existsSync(first)).toBe(false);
});

it('does not send an oversized context', async () => {
  const deps = fixture();
  writeFileSync(deps.profileFile, '资料'.repeat(110_000));
  const runText = vi.fn(async () => ({ text: '', provider: 'fixture' }));
  const runner = new AgentRunner(deps, { runText });
  await runner.run('organize');
  expect(runner.status().error).toContain('超过 20 万字');
  expect(runText).not.toHaveBeenCalled();
});

it('rejects a result if the active user changed while the model was working', async () => {
  const deps = fixture(); const originalDb = deps.db, other = openDb(':memory:');
  try {
    const runner = new AgentRunner(deps, { runText: async () => {
      deps.db = other;
      return { text: plan([{ file: 'lesson.md', note }]), provider: 'fixture' };
    } });
    await runner.run('organize');
    expect(runner.status().error).toContain('用户已切换');
    expect(existsSync(join(deps.localNotes, 'lesson.md'))).toBe(false);
  } finally { deps.db = originalDb; other.close(); }
});

it('cancels an actual pending HTTP request without saving anything', async () => {
  const deps = fixture(); let received!: () => void;
  const ready = new Promise<void>(r => { received = r; });
  const server = createServer((_req, _res) => { received(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const settings = readAiSettings(deps.dataDir);
    settings.endpoints.test!.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    writeAiSettings(deps.dataDir, settings);
    const runner = new AgentRunner(deps); const pending = runner.run('organize');
    await ready; runner.cancel(); await pending;
    expect(runner.status().state).toBe('cancelled');
    expect(runner.status().error).toBeNull();
    expect(existsSync(join(deps.localNotes, 'lesson.md'))).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
