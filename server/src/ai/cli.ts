import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import which from 'which';
import type { AiCliKind, AiSettings } from './settings.js';

export interface CliInvocation {
  command: string;
  args: string[];
  displayName: string;
  /** Keep multiline prompts out of Windows npm .cmd argument parsing. */
  input?: string;
}

/**
 * 单次调用的覆盖。空串 = **不传**这个参数（用命令行工具自己的默认）。
 *
 * 连接测试走这里：它只验「这条命令行能不能连上」，不套用用户设的模型和档位。
 */
export interface CliOverrides {
  effort?: string;
  model?: string;
}

/** 按空格分词，保留单双引号；`{prompt}` 占位，没写就追加 */
export function parseCustomArgs(template: string, prompt: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let dq = false;
  let sq = false;
  let used = false;
  const push = () => {
    if (!cur) return;
    if (cur.includes('{prompt}')) {
      used = true;
      cur = cur.replaceAll('{prompt}', prompt);
    }
    tokens.push(cur);
    cur = '';
  };
  for (const ch of template.trim()) {
    if (ch === '"' && !sq) dq = !dq;
    else if (ch === "'" && !dq) sq = !sq;
    else if (/\s/.test(ch) && !dq && !sq) push();
    else cur += ch;
  }
  push();
  if (!used) tokens.push(prompt);
  return tokens;
}

export function resolveCliInvocation(
  settings: Pick<AiSettings, 'cli'>,
  prompt: string,
  mode: 'text' | 'agent',
  over: CliOverrides = {},
): CliInvocation {
  const { kind, path, customArgs } = settings.cli;
  if (mode === 'agent') {
    const reason = agentBoundaryError(kind);
    if (reason) throw new Error(reason);
  }
  const custom = path.trim();

  if (kind === 'codex') {
    return {
      command: custom || 'codex',
      displayName: 'codex',
      args: ['exec', '--sandbox', mode === 'agent' ? 'workspace-write' : 'read-only', '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '--ephemeral', '--skip-git-repo-check', '-'],
      input: prompt,
    };
  }
  if (kind === 'gemini') {
    return {
      command: custom || 'gemini',
      displayName: 'gemini',
      args: ['-p', prompt, '--sandbox', '--approval-mode', mode === 'agent' ? 'auto_edit' : 'plan', '-o', 'json'],
    };
  }
  if (kind === 'agy') {
    // agy 默认拿的是**带思考**的档：回一句「OK」也要先想一遍。档位和模型都能调，
    // 空串就不传这个参数，交给 agy 自己的默认。实测参数放在提示词前后都认
    // （它的日志里 promptLength 没变），放后面是为了跟别的分支的写法一致。
    const effort = (over.effort ?? settings.cli.effort ?? '').trim();
    const model = (over.model ?? settings.cli.model ?? '').trim();
    // agent 模式到不了这里：resolveCliInvocation 开头就按 agentBoundaryError 拒绝了 agy。
    const args = mode === 'agent'
      ? ['-p', prompt, '--mode', 'accept-edits']
      : ['-p', prompt];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return {
      command: custom || 'agy',
      displayName: 'agy',
      args,
    };
  }
  if (kind === 'custom') {
    const file = custom.split(/[\\/]/).pop() || '';
    return {
      command: custom || 'claude',
      displayName: file ? `自定义命令（${file}）` : 'claude',
      args: parseCustomArgs(customArgs, prompt),
    };
  }
  const claudeModel = (over.model ?? settings.cli.model ?? '').trim() || nativeClaudeModel();
  return {
    command: custom || 'claude',
    displayName: 'claude',
    args: mode === 'agent'
      ? ['-p', prompt, '--restricted', '--strict-mcp-config', '--disable-slash-commands', ...(claudeModel ? ['--model', claudeModel] : []), '--tools', 'Read,Edit,Write,Glob,Grep', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--output-format', 'json', '--no-session-persistence']
      : ['-p', prompt, '--tools', '', '--permission-prompts', 'none', '--output-format', 'json', '--no-session-persistence'],
  };
}

/** Native restricted mode ignores user settings, so preserve the user's model selection only. */
function nativeClaudeModel(): string {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  try {
    const raw = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'), 'utf8'));
    return typeof raw.model === 'string' ? raw.model : '';
  } catch { return ''; }
}

export function agentBoundaryError(kind: AiCliKind): string | null {
  if (kind === 'agy') return '当前 agy 的 sandbox 无法限制文件工具越界写入，请改用支持目录隔离的 Claude Code、Codex 或 Gemini CLI 整理；讲解仍可使用 agy。';
  if (kind === 'custom') return '自定义命令没有可验证的文件权限边界，请选择支持目录隔离的命令行整理，或生成草稿后手动保存。';
  return null;
}

function cliReportedError(output: string): string | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const result = JSON.parse(line);
      if (result?.is_error === true) return typeof result.result === 'string' ? result.result.slice(0, 500) : '命令行 AI 返回执行错误';
    } catch { /* stderr can accompany JSON output */ }
  }
  return null;
}

export function commandExists(command: string): boolean {
  try {
    return Boolean(which.sync(command, { nothrow: true }));
  } catch {
    return false;
  }
}

function parseText(raw: string, kind: AiCliKind): string {
  const s = raw.trim();
  if (kind === 'claude' || kind === 'gemini') {
    try {
      const j = JSON.parse(s) as { result?: unknown; response?: unknown; text?: unknown };
      const v = j.result ?? j.response ?? j.text;
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch { /* 回落原始 stdout */ }
  }
  return s;
}

function spawnCli(inv: CliInvocation, args: string[], cwd: string | undefined) {
  const child = crossSpawn(inv.command, args, { cwd, stdio: [inv.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
  if (inv.input !== undefined) {
    // A CLI may reject its arguments and close stdin before accepting the prompt.
    // Its error/close handlers report the failure; EPIPE must not crash the server.
    child.stdin?.on('error', () => {});
    child.stdin?.end(inv.input);
  }
  return child;
}

export async function runCliText(
  inv: CliInvocation,
  opts: { timeoutMs?: number; cwd?: string; kind?: AiCliKind } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let args = inv.args.slice();
  let lastFile: string | null = null;
  let tempDir: string | null = null;
  if (opts.kind === 'codex') {
    tempDir = mkdtempSync(join(tmpdir(), 'zhengyin-cli-'));
    lastFile = join(tempDir, 'last.txt');
    const prompt = args.pop()!;
    args = [...args, '--output-last-message', lastFile, prompt];
  }

  const child = spawnCli(inv, args, opts.cwd);
  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr?.on('data', (b: Buffer) => { err += b.toString(); });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(() => reject(new Error(`命令行 AI 超过 ${Math.round(timeoutMs / 1000)}s 没有返回`)));
    }, timeoutMs);

    child.on('error', (e) => finish(() => reject(new Error(`起不了 ${inv.displayName}：${e.message}。去设置里检查路径，或改用接口模式。`))));
    child.on('close', (code) => {
      try {
        finish(() => {
          if (code !== 0) return reject(new Error(`${inv.displayName} 退出码 ${code ?? '未知'}：${err.trim().slice(-500) || out.trim().slice(-500)}`));
          if (lastFile && existsSync(lastFile)) {
            const text = readFileSync(lastFile, 'utf8').trim();
            if (text) return resolve(text);
          }
          const reported = cliReportedError(out);
          if (reported) return reject(new Error(reported));
          const text = parseText(out, opts.kind ?? 'custom');
          if (!text) return reject(new Error(`${inv.displayName} 没有输出任何内容`));
          resolve(text);
        });
      } finally {
        // close still cleans up when timeout has already settled the promise.
        if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 文件占用时保留临时输出 */ } }
      }
    });
  });
}

export async function runCliAgent(
  inv: CliInvocation,
  opts: { cwd: string; timeoutMs?: number; onLog: (line: string) => void; onChild?: (pid: number | undefined) => void },
): Promise<{ code: number | null; output: string }> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const child = spawnCli(inv, inv.args, opts.cwd);
  opts.onChild?.(child.pid);
  let out = '';
  const onData = (b: Buffer) => {
    const s = b.toString();
    out += s;
    for (const line of s.split(/[\r\n]+/)) if (line.trim()) opts.onLog(line.trimEnd());
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(() => reject(new Error(`AI 整理超过 ${Math.round(timeoutMs / 1000)}s，已经中止`)));
    }, timeoutMs);
    child.on('error', (e) => finish(() => reject(new Error(`起不了 ${inv.displayName}：${e.message}`))));
    child.on('close', (code) => finish(() => {
      const reported = cliReportedError(out);
      if (reported) reject(new Error(reported));
      else resolve({ code, output: out });
    }));
  });
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
