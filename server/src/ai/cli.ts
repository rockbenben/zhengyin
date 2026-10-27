import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import which from 'which';
import type { AiCliKind, AiSettings } from './settings.js';

export interface CliInvocation {
  command: string;
  args: string[];
  displayName: string;
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
): CliInvocation {
  const { kind, path, customArgs } = settings.cli;
  const custom = path.trim();

  if (kind === 'codex') {
    return {
      command: custom || 'codex',
      displayName: 'codex',
      args: ['exec', '--sandbox', mode === 'agent' ? 'workspace-write' : 'read-only', '--skip-git-repo-check', prompt],
    };
  }
  if (kind === 'gemini') {
    return {
      command: custom || 'gemini',
      displayName: 'gemini',
      args: ['-p', prompt, '--approval-mode', mode === 'agent' ? 'auto_edit' : 'plan', '-o', 'json'],
    };
  }
  if (kind === 'agy') {
    return {
      command: custom || 'agy',
      displayName: 'agy',
      args: mode === 'agent'
        ? ['-p', prompt, '--mode', 'accept-edits', '--dangerously-skip-permissions']
        : ['-p', prompt],
    };
  }
  if (kind === 'custom') {
    return {
      command: custom || 'claude',
      displayName: custom || 'claude',
      args: parseCustomArgs(customArgs, prompt),
    };
  }
  return {
    command: custom || 'claude',
    displayName: 'claude',
    args: mode === 'agent'
      ? ['-p', prompt, '--tools', 'Read,Edit,Write,Glob,Grep', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--output-format', 'json']
      : ['-p', prompt, '--tools', '', '--permission-prompts', 'none', '--output-format', 'json', '--no-session-persistence'],
  };
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

  const child = crossSpawn(inv.command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr?.on('data', (b: Buffer) => { err += b.toString(); });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退 */ }
      finish(() => reject(new Error(`命令行 AI 超过 ${Math.round(timeoutMs / 1000)}s 没有返回`)));
    }, timeoutMs);

    child.on('error', (e) => finish(() => reject(new Error(`起不了 ${inv.displayName}：${e.message}。去设置里检查路径，或改用接口模式。`))));
    child.on('exit', (code) => finish(() => {
      try {
        if (lastFile && existsSync(lastFile)) {
          const text = readFileSync(lastFile, 'utf8').trim();
          if (text) return resolve(text);
        }
        if (code !== 0) return reject(new Error(`${inv.displayName} 退出码 ${code ?? '未知'}：${err.trim().slice(-500) || out.trim().slice(-500)}`));
        const text = parseText(out, opts.kind ?? 'custom');
        if (!text) return reject(new Error(`${inv.displayName} 没有输出任何内容`));
        resolve(text);
      } finally {
        if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 临时目录下次会清 */ } }
      }
    }));
  });
}

export async function runCliAgent(
  inv: CliInvocation,
  opts: { cwd: string; timeoutMs?: number; onLog: (line: string) => void; onChild?: (pid: number | undefined) => void },
): Promise<{ code: number | null; output: string }> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const child = crossSpawn(inv.command, inv.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
      finish(() => reject(new Error('AI 整理超过 10 分钟，已经中止')));
    }, timeoutMs);
    child.on('error', (e) => finish(() => reject(new Error(`起不了 ${inv.displayName}：${e.message}`))));
    child.on('exit', (code) => finish(() => resolve({ code, output: out })));
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
