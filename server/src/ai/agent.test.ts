import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logAttempt, openDb, upsertEntry } from '../db.js';
import { NoteStore } from '../notes.js';
import { AgentRunner, prepareReference, type AgentDeps } from './agent.js';

const noteMd = (id: string, title: string, triggers = '[phoneme:l, phoneme:n]'): string => `---
id: ${id}
title: ${title}
triggers: ${triggers}
---
## 自检法
捏住鼻子发，发得出声就是 /l/。

## 对比训练
中文「老 / 脑」先分清，再练 light / night。
`;

function agentDeps(): AgentDeps {
  const appRoot = mkdtempSync(join(tmpdir(), 'agent-'));
  const dataDir = join(appRoot, 'data');
  const localNotes = join(dataDir, 'notes');
  const userDir = join(dataDir, 'users', '测试');
  mkdirSync(localNotes, { recursive: true });
  mkdirSync(userDir, { recursive: true });

  const shippedNotes = mkdtempSync(join(tmpdir(), 'agent-shipped-'));
  writeFileSync(join(shippedNotes, 'seed.md'), noteMd('seed', '随附的 l/n'), 'utf8');

  const workflowsDir = mkdtempSync(join(tmpdir(), 'agent-wf-'));
  writeFileSync(join(workflowsDir, 'agent.md'), '# 代理规则\n只写本机笔记。\n', 'utf8');
  writeFileSync(join(workflowsDir, 'coach.md'), '# 教练提示\n', 'utf8');

  const profileFile = join(userDir, '发音档案.md');
  writeFileSync(profileFile, '# 发音档案\n\n## 已确认的习惯问题\n（还没有）\n', 'utf8');

  const db = openDb(join(userDir, 'index.db'));
  upsertEntry(db, 'click', [{
    word: 'click', found: true, arpabet: ['K', 'L', 'IH1', 'K'], ipa: 'ˈklɪk', tags: ['phoneme:l'],
    phoneIpa: ['k', 'l', 'ɪ', 'k'], phoneTags: [[], [], [], []],
    syllables: [[0, 1, 2, 3]], syllableStress: [1],
  }], 't1');
  logAttempt(db, {
    entryText: 'click', target: 'click', at: 't1',
    targetIpa: ['k', 'l', 'ɪ', 'k'], heardIpa: ['k', 'n', 'ɪ', 'k'],
    clean: false,
    ops: [
      { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
      { kind: 'sub', targetIpa: 'l', heardIpa: 'n' },
      { kind: 'match', targetIpa: 'ɪ', heardIpa: 'ɪ' },
      { kind: 'match', targetIpa: 'k', heardIpa: 'k' },
    ],
  });

  const noteStore = new NoteStore([
    { dir: shippedNotes, source: 'shipped' },
    { dir: localNotes, source: 'local' },
  ]);
  noteStore.load();

  return {
    appRoot, dataDir, localNotes, shippedNotes, workflowsDir, profileFile, db, noteStore,
    userName: () => '测试',
    now: () => '2026-10-27T00:00:00.000Z',
  };
}

describe('prepareReference', () => {
  it('每次全量刷新只读副本，旧文件不会留在里面', () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'ref-'));
    const shipped = mkdtempSync(join(tmpdir(), 'ref-shipped-'));
    const workflows = mkdtempSync(join(tmpdir(), 'ref-wf-'));
    writeFileSync(join(shipped, 'a.md'), '笔记', 'utf8');
    writeFileSync(join(workflows, 'agent.md'), '规则', 'utf8');
    mkdirSync(join(appRoot, '.ai-reference', 'notes'), { recursive: true });
    writeFileSync(join(appRoot, '.ai-reference', 'notes', 'stale.md'), '旧的', 'utf8');

    prepareReference(appRoot, shipped, workflows);

    expect(readFileSync(join(appRoot, '.ai-reference', 'notes', 'a.md'), 'utf8')).toBe('笔记');
    expect(existsSync(join(appRoot, '.ai-reference', 'notes', 'stale.md'))).toBe(false);
    expect(readFileSync(join(appRoot, '.ai-reference', 'workflows', 'agent.md'), 'utf8')).toBe('规则');
  });
});

describe('AgentRunner', () => {
  it('快照 + 假 CLI 写一篇笔记 → diff 有新增；撤销后文件消失', async () => {
    const deps = agentDeps();
    const runner = new AgentRunner(deps, {
      runAgent: async ({ cwd, onLog }) => {
        writeFileSync(join(cwd, 'data', 'notes', 'ai-test.md'), noteMd('ai-test', '新笔记'), 'utf8');
        onLog('wrote note');
        return { code: 0, output: 'done' };
      },
    });

    await runner.run('organize');
    const st = runner.status();
    expect(st.state).toBe('done');
    expect(st.changed?.added).toContain('data/notes/ai-test.md');
    expect(st.logs).toContain('wrote note');
    expect(st.outOfScope, '重算归属写的 DB 被当成了代理越界').toEqual([]);
    expect(deps.noteStore.get('ai-test')?.source).toBe('local');

    runner.undo();
    expect(existsSync(join(deps.localNotes, 'ai-test.md'))).toBe(false);
    expect(runner.status().state).toBe('undone');
  });

  it('磁盘快照被代理改过也不影响撤销：用的是运行时那份', async () => {
    const deps = agentDeps();
    const runner = new AgentRunner(deps, {
      runAgent: async ({ cwd }) => {
        writeFileSync(join(cwd, 'data', 'notes', 'ai-test.md'), noteMd('ai-test', '新笔记'), 'utf8');
        return { code: 0, output: '' };
      },
    });
    await runner.run('organize');
    const runId = runner.status().runId!;
    expect(runId).toBeTruthy();

    writeFileSync(join(deps.dataDir, 'ai-runs', runId, 'snapshot.json'), JSON.stringify({
      createdAt: '', appRoot: deps.appRoot, dataDirRel: 'data',
      profileRel: 'data/users/测试/发音档案.md', localNotesRel: 'data/notes',
      profile: null, notes: {}, data: {},
    }), 'utf8');

    runner.undo();
    expect(existsSync(join(deps.localNotes, 'ai-test.md'))).toBe(false);
    expect(readFileSync(deps.profileFile, 'utf8')).toContain('（还没有）');
  });

  it('改了不该改的文件会被点名，撤销不碰它', async () => {
    const deps = agentDeps();
    const runner = new AgentRunner(deps, {
      runAgent: async ({ cwd }) => {
        writeFileSync(join(cwd, 'data', '当前用户.txt'), '别人\n', 'utf8');
        return { code: 0, output: '' };
      },
    });

    await runner.run('organize');
    expect(runner.status().outOfScope).toEqual([{ path: 'data/当前用户.txt', kind: 'added' }]);

    runner.undo();
    expect(existsSync(join(deps.dataDir, '当前用户.txt'))).toBe(true);
  });

  it('改过和删掉的笔记都能整批还原', async () => {
    const deps = agentDeps();
    writeFileSync(join(deps.localNotes, 'keep.md'), noteMd('keep', '保留'), 'utf8');
    writeFileSync(join(deps.localNotes, 'gone.md'), noteMd('gone', '删掉'), 'utf8');
    deps.noteStore.load();

    const runner = new AgentRunner(deps, {
      runAgent: async ({ cwd }) => {
        writeFileSync(join(cwd, 'data', 'notes', 'keep.md'), noteMd('keep', '被改过'), 'utf8');
        unlinkSync(join(cwd, 'data', 'notes', 'gone.md'));
        return { code: 0, output: '' };
      },
    });

    await runner.run('organize');
    const st = runner.status();
    expect(st.changed?.modified).toContain('data/notes/keep.md');
    expect(st.changed?.removed).toContain('data/notes/gone.md');

    runner.undo();
    expect(readFileSync(join(deps.localNotes, 'keep.md'), 'utf8')).toContain('保留');
    expect(readFileSync(join(deps.localNotes, 'gone.md'), 'utf8')).toContain('删掉');
  });

  it('新笔记没通过校验时，只报与它相关的告警', async () => {
    const deps = agentDeps();
    const runner = new AgentRunner(deps, {
      runAgent: async ({ cwd }) => {
        writeFileSync(join(cwd, 'data', 'notes', 'bad.md'), `---
id: bad
title: 坏的
triggers: [phoneme:l]
---
只有一句话。
`, 'utf8');
        return { code: 0, output: '' };
      },
    });

    await runner.run('organize');
    expect(runner.status().noteWarnings.some((w) => w.includes('bad.md'))).toBe(true);
  });

  it('代理弄坏 AUTO 标记时 autoOk 是 false，撤销后恢复', async () => {
    const deps = agentDeps();
    const broken = readFileSync(deps.profileFile, 'utf8') + '\n<!-- AUTO:发音统计 开始（这一块由工具生成，手改会在下次评测后被覆盖） -->\n';
    const runner = new AgentRunner(deps, {
      runAgent: async () => {
        writeFileSync(deps.profileFile, broken, 'utf8');
        return { code: 0, output: '' };
      },
    });

    await runner.run('profile');
    expect(runner.status().autoOk).toBe(false);

    runner.undo();
    expect(runner.status().autoOk).toBe(true);
    expect(readFileSync(deps.profileFile, 'utf8')).toContain('（还没有）');
  });

  it('取消后不会再被退出码改写成 error', async () => {
    const deps = agentDeps();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });

    const runner = new AgentRunner(deps, {
      runAgent: async ({ onChild }) => {
        onChild(undefined);
        started();
        await gate;
        return { code: 1, output: '' };
      },
    });

    const run = runner.run('organize');
    await ready;
    runner.cancel();
    expect(runner.status().cancelling).toBe(true);
    release();
    await run;

    expect(runner.status().state).toBe('cancelled');
    expect(runner.status().cancelling).toBe(false);
  });

  it('接口模式不启动文件代理，也不在档案上留下改动', async () => {
    const deps = agentDeps();
    writeFileSync(join(deps.dataDir, 'ai-settings.json'), JSON.stringify({
      schemaVersion: 1, consent: true, mode: 'api', endpointId: '', endpoints: {},
      cli: { kind: 'claude', path: '', customArgs: '' },
    }), 'utf8');
    const before = readFileSync(deps.profileFile, 'utf8');

    const runner = new AgentRunner(deps);
    await runner.run('organize');

    expect(runner.status().state).toBe('error');
    expect(runner.status().error).toContain('命令行代理');
    expect(readFileSync(deps.profileFile, 'utf8')).toBe(before);
  });
});
