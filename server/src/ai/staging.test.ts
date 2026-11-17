import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotAllowed } from './agent.js';
import { prepareAgentWorkspace, commitAgentWorkspace } from './staging.js';

it('submits allowed profile sections while preserving newer automatic statistics', () => {
  const root = mkdtempSync(join(tmpdir(), 'staging-'));
  const notes = join(root, 'notes'); const workflows = join(root, 'workflows');
  mkdirSync(notes); mkdirSync(workflows);
  writeFileSync(join(workflows, 'agent.md'), '整理规则');
  const referenceNote = '---\nid: reference\ntitle: 参考笔记\ntriggers: [phoneme:l]\n---\n## 自检法\n自检\n## 对比训练\nlight / night\n';
  writeFileSync(join(notes, 'reference.md'), referenceNote);
  const profileFile = join(root, 'profile.md');
  writeFileSync(profileFile, '# 档案\n## 已确认的习惯问题\n旧\n## 待观察\n无\n<!-- AUTO:统计 -->\n原统计');
  const live = {appRoot:root, dataDir:root, localNotes:notes, profileFile};
  const before = snapshotAllowed(live);
  const staged = prepareAgentWorkspace(join(root, 'work'), live, notes, workflows);
  expect(readFileSync(join(staged.appRoot, '.ai-reference', 'workflows', 'agent.md'), 'utf8')).toBe('整理规则');
  expect(readFileSync(join(staged.appRoot, '.ai-reference', 'notes', 'reference.md'), 'utf8')).toBe(referenceNote);
  writeFileSync(staged.profileFile, readFileSync(staged.profileFile,'utf8').replace('旧', '新'));
  writeFileSync(profileFile, readFileSync(profileFile,'utf8').replace('原统计','新统计'));
  commitAgentWorkspace(staged, live, before);
  expect(readFileSync(profileFile,'utf8')).toContain('新统计');
  expect(readFileSync(profileFile,'utf8')).toContain('问题\n新');
  writeFileSync(staged.profileFile, readFileSync(staged.profileFile,'utf8').replace('# 档案', '# 被改'));
  expect(() => commitAgentWorkspace(staged, live, before)).toThrow();
});
