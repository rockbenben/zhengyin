import { describe, it, expect } from 'vitest';
import { commandExists, parseCustomArgs, resolveCliInvocation } from './cli.js';
import type { AiCliKind } from './settings.js';

const s = (kind: AiCliKind, path = '', customArgs = '') => ({ cli: { kind, path, customArgs } });

describe('CLI 参数', () => {
  it('claude 文本模式禁掉全部工具', () => {
    const inv = resolveCliInvocation(s('claude'), 'P', 'text');
    expect(inv.args).toContain('--tools');
    expect(inv.args[inv.args.indexOf('--tools') + 1]).toBe('');
    expect(inv.args).toContain('--output-format');
  });

  it('claude 代理模式给读写工具、不给 Bash', () => {
    const inv = resolveCliInvocation(s('claude'), 'P', 'agent');
    const tools = inv.args[inv.args.indexOf('--tools') + 1];
    expect(tools).toBe('Read,Edit,Write,Glob,Grep');
    expect(tools).not.toContain('Bash');
  });

  it('codex / gemini 文本模式是只读/plan；代理模式可写', () => {
    expect(resolveCliInvocation(s('codex'), 'P', 'text').args).toContain('read-only');
    expect(resolveCliInvocation(s('codex'), 'P', 'agent').args).toContain('workspace-write');
    expect(resolveCliInvocation(s('gemini'), 'P', 'text').args).toContain('plan');
    expect(resolveCliInvocation(s('gemini'), 'P', 'agent').args).toContain('auto_edit');
  });

  it('custom 的 {prompt} 占位；没写就追加', () => {
    expect(parseCustomArgs('--x {prompt}', 'P')).toEqual(['--x', 'P']);
    expect(parseCustomArgs('--x', 'P')).toEqual(['--x', 'P']);
    expect(parseCustomArgs('', 'P')).toEqual(['P']);
  });

  it('自定义路径优先生效', () => {
    expect(resolveCliInvocation(s('claude', 'C:/my-claude.exe'), 'P', 'text').command).toBe('C:/my-claude.exe');
  });
});

it('commandExists 认 PATH / 绝对路径，不认识假命令', () => {
  expect(commandExists(process.execPath)).toBe(true);
  expect(commandExists('definitely-not-a-cli-xyz')).toBe(false);
});
