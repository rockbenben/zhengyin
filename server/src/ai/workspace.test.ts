import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliWorkspace } from './workspace.js';

describe('命令行调用的工作目录', () => {
  it('在数据目录下建一个空的专用目录', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zy-ws-'));
    const dir = cliWorkspace(dataDir);
    expect(dir).toBe(join(dataDir, 'ai-workspace'));
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('不是数据目录本身：那儿的大文件、规则文件都读不到', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zy-ws-'));
    // 数据目录里可能躺着别的东西；命令行工具把它当工作区就会读进去。
    writeFileSync(join(dataDir, 'AGENTS.md'), '规则', 'utf8');
    const dir = cliWorkspace(dataDir);
    expect(dir).not.toBe(dataDir);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('再调一次还是同一个目录（工具的项目上下文才稳定）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zy-ws-'));
    expect(cliWorkspace(dataDir)).toBe(cliWorkspace(dataDir));
  });
});
