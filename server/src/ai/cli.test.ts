import { describe, it, expect } from 'vitest';
import { commandExists, parseCustomArgs, resolveCliInvocation } from './cli.js';
import type { AiCliKind } from './settings.js';

const s = (kind: AiCliKind, path = '', customArgs = '', effort = '', model = '') =>
  ({ cli: { kind, path, customArgs, effort, model } });

describe('CLI 参数', () => {
  it('Codex 的多行上下文通过 stdin 传递，不经过 Windows 批处理参数', () => {
    const prompt = '第一行\n任务与资料\n"引号" & 符号';
    for (const mode of ['text', 'agent'] as const) {
      const inv = resolveCliInvocation(s('codex'), prompt, mode);
      expect(inv.args.at(-1)).toBe('-');
      expect(inv.args).not.toContain(prompt);
      expect(inv).toHaveProperty('input', prompt);
    }
  });
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

  it('agy 的档位和模型：填了才传，空着就不传', () => {
    const bare = resolveCliInvocation(s('agy'), 'P', 'text');
    expect(bare.args).not.toContain('--effort');
    expect(bare.args).not.toContain('--model');

    const set = resolveCliInvocation(s('agy', '', '', 'low', 'gpt-oss-120b-medium'), 'P', 'text');
    expect(set.args[set.args.indexOf('--effort') + 1]).toBe('low');
    expect(set.args[set.args.indexOf('--model') + 1]).toBe('gpt-oss-120b-medium');
    expect(set.args[0]).toBe('-p');
    expect(set.args[1]).toBe('P');
  });

  it('agy 的模型不会串到 claude——设置里那个输入框只对 agy 生效', () => {
    const inv = resolveCliInvocation(s('claude', '', '', 'low', 'agy-only-model'), 'P', 'agent');
    expect(inv.args).not.toContain('agy-only-model');
    const i = inv.args.indexOf('--model');
    if (i >= 0) expect(inv.args[i + 1]).not.toBe('agy-only-model');
  });

  it('覆盖优先于设置：连接测试用最低档、不带模型', () => {
    const inv = resolveCliInvocation(s('agy', '', '', 'high', 'some-model'), 'P', 'text', { effort: 'low', model: '' });
    expect(inv.args[inv.args.indexOf('--effort') + 1]).toBe('low');
    expect(inv.args).not.toContain('--model');
  });

  it('agy 自动整理在启动前明确拒绝未经隔离的文件写入', () => {
    expect(() => resolveCliInvocation(s('agy', '', '', 'medium', 'm'), 'P', 'agent')).toThrow(/无法限制文件工具/);
  });

  it('自定义路径优先生效', () => {
    expect(resolveCliInvocation(s('claude', 'C:/my-claude.exe'), 'P', 'text').command).toBe('C:/my-claude.exe');
  });

  it('自定义命令的显示名只取文件名，不把整条路径甩到界面上', () => {
    expect(resolveCliInvocation(s('custom', 'C:/Tools/node.exe'), 'P', 'text').displayName)
      .toBe('自定义命令（node.exe）');
    expect(resolveCliInvocation(s('custom', 'C:\\Tools\\node.exe'), 'P', 'text').displayName)
      .toBe('自定义命令（node.exe）');
    expect(resolveCliInvocation(s('custom'), 'P', 'text').displayName).toBe('claude');
  });
});

it('commandExists 认 PATH / 绝对路径，不认识假命令', () => {
  expect(commandExists(process.execPath)).toBe(true);
  expect(commandExists('definitely-not-a-cli-xyz')).toBe(false);
});

it('requires native confinement and excludes temporary writable roots', () => {
  const claude = resolveCliInvocation(s('claude'), 'P', 'agent');
  expect(claude.args).toContain('--restricted');
  expect(claude.args).toContain('--strict-mcp-config');
  expect(resolveCliInvocation(s('gemini'), 'P', 'agent').args).toContain('--sandbox');
  expect(resolveCliInvocation(s('codex'), 'P', 'agent').args).toContain('sandbox_workspace_write.writable_roots=[]');
  expect(() => resolveCliInvocation(s('custom'), 'P', 'agent')).toThrow(/权限边界/);
});
