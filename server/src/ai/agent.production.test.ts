import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from './agent.js';
import { mergeAiSettings, readAiSettings, writeAiSettings } from './settings.js';
import { NoteStore } from '../notes.js';
import { openDb } from '../db.js';

it.each(['agy', 'custom'] as const)('unconfined %s is rejected before spawning', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'agent-production-'));
  const dataDir = join(root, 'data'); const localNotes = join(dataDir, 'notes');
  const shippedNotes = join(root, 'shipped'); const workflowsDir = join(root, 'workflows');
  for (const dir of [localNotes, shippedNotes, workflowsDir]) mkdirSync(dir, {recursive:true});
  writeFileSync(join(workflowsDir,'agent.md'), '只修改允许的内容');
  const profileFile = join(dataDir, 'profile.md');
  writeFileSync(profileFile, '# 档案\n## 已确认的习惯问题\n旧\n## 待观察\n无\n');
  const md = '---\nid: sample\ntitle: 示例\ntriggers: [phoneme:l]\n---\n## 自检法\n测试\n## 对比训练\nlight / night\n';
  const target = join(localNotes, 'sample.md');
  const script = join(root, 'fixture.cjs');
  const source = "const fs=require('node:fs');fs.writeFileSync('data/notes/sample.md'," + JSON.stringify(md) + ");"
    ;
  writeFileSync(script, source);
  writeAiSettings(dataDir, mergeAiSettings({mode:'cli',consent:true,cli:{kind,path:process.execPath,customArgs:JSON.stringify(script)}}, readAiSettings(dataDir)));
  const noteStore = new NoteStore([{dir:shippedNotes,source:'shipped'},{dir:localNotes,source:'local'}]);
  noteStore.load();
  const db = openDb(':memory:');
  const runner = new AgentRunner({appRoot:root,dataDir,localNotes,shippedNotes,workflowsDir,profileFile,db,noteStore,userName:()=> '测试',now:()=>new Date().toISOString()});
  await runner.run('organize');
  expect(runner.status().state).toBe('error');
  expect(runner.status().error).toMatch(/目录隔离|权限边界/);
  expect(existsSync(target)).toBe(false);
  expect(runner.status().runId).toBeNull();
  db.close();
});
