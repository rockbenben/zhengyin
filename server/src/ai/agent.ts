import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { NoteStore } from '../notes.js';
import { BEGIN, END, syncProfile } from '../profile.js';
import { reconcileAttempts } from '../reconcile.js';
import { writeFileAtomic } from '../atomic.js';
import { readAiSettings } from './settings.js';
import { killTree, resolveCliInvocation, runCliAgent } from './cli.js';
import { buildAgentPrompt } from './context.js';

/** 代理能用的两件事：读当前用户的档案与笔记，写本机笔记和档案手写两节。 */
export interface AgentDeps {
  appRoot: string;
  dataDir: string;
  localNotes: string;
  shippedNotes: string;
  workflowsDir: string;
  noteStore: NoteStore;
  db: Database.Database;
  profileFile: string;
  /** 运行时再读：整理跑的这段时间里用户可能被切走 */
  userName: () => string;
  now: () => string;
}

export interface AgentSnapshotDeps {
  appRoot: string;
  dataDir: string;
  localNotes: string;
  profileFile: string;
}

export interface Snapshot {
  createdAt: string;
  appRoot: string;
  dataDirRel: string;
  profileRel: string;
  localNotesRel: string;
  profile: string | null;
  /** 本机笔记：目录内相对路径（POSIX 分隔）→ 内容 */
  notes: Record<string, string>;
  /** data/ 的基线（除 audio/models/ai-runs）：相对路径 → 内容 hash。只用于越界检测 */
  data: Record<string, string>;
}

export interface SnapshotDiff { added: string[]; modified: string[]; removed: string[] }
export interface OutOfScope { path: string; kind: 'added' | 'modified' | 'removed' }

export type AgentState = 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'undone';
export interface AgentStatus {
  state: AgentState;
  logs: string[];
  startedAt: number | null;
  finishedAt: number | null;
  changed: SnapshotDiff | null;
  outOfScope: OutOfScope[];
  noteWarnings: string[];
  autoOk: boolean | null;
  runId: string | null;
  error: string | null;
  cancelling: boolean;
}

export type AgentTask = 'organize' | 'profile' | 'custom';

export interface AgentRunArgs {
  cwd: string;
  prompt: string;
  onLog: (line: string) => void;
  onChild: (pid: number | undefined) => void;
}
export interface AgentRunResult { code: number | null; output: string; displayName?: string }
export type AgentRunFn = (args: AgentRunArgs) => Promise<AgentRunResult>;
export interface AgentRunnerOptions { runAgent?: AgentRunFn }

const posix = (p: string): string => p.split(sep).join('/');
const relTo = (root: string, p: string): string => posix(relative(root, p));
const joinRel = (a: string, b: string): string => (a ? `${a.replace(/\/+$/, '')}/${b}` : b);
const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex');

const EXCLUDED_TOP = new Set(['audio', 'models', 'ai-runs']);
const MAX_LOGS = 500;

function walkFiles(root: string, rel = ''): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

function dataFiles(dataDir: string, rel = ''): string[] {
  let entries;
  try {
    entries = readdirSync(join(dataDir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!rel && EXCLUDED_TOP.has(e.name)) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...dataFiles(dataDir, child));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    // 不存在 = 这个用户还没铺档案（或者代理把它删了），算「没有」；
    // 权限之类读不了则不能当成不存在——否则撤销会拿「什么都没有」去覆盖真文件。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

function dataBaseline(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of dataFiles(dataDir)) {
    try { out[rel] = sha1(readFileSync(join(dataDir, rel))); } catch { /* 读不到就不记，不能因此让整理停摆 */ }
  }
  return out;
}

export function snapshotAllowed(deps: AgentSnapshotDeps): Snapshot {
  const notes: Record<string, string> = {};
  for (const rel of walkFiles(deps.localNotes)) {
    const text = readText(join(deps.localNotes, rel));
    if (text !== null) notes[rel] = text;
  }
  return {
    createdAt: new Date().toISOString(),
    appRoot: deps.appRoot,
    dataDirRel: relTo(deps.appRoot, deps.dataDir),
    profileRel: relTo(deps.appRoot, deps.profileFile),
    localNotesRel: relTo(deps.appRoot, deps.localNotes),
    profile: readText(deps.profileFile),
    notes,
    data: dataBaseline(deps.dataDir),
  };
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  if (before.profile !== after.profile) {
    if (before.profile === null) added.push(before.profileRel);
    else if (after.profile === null) removed.push(before.profileRel);
    else modified.push(before.profileRel);
  }

  const keys = new Set([...Object.keys(before.notes), ...Object.keys(after.notes)]);
  for (const rel of keys) {
    const label = joinRel(before.localNotesRel, rel);
    const a = before.notes[rel];
    const b = after.notes[rel];
    if (a === undefined) added.push(label);
    else if (b === undefined) removed.push(label);
    else if (a !== b) modified.push(label);
  }

  const sort = (xs: string[]) => xs.sort((x, y) => x.localeCompare(y, 'zh'));
  return { added: sort(added), modified: sort(modified), removed: sort(removed) };
}

/** 把随附笔记与提示词复制到 appRoot 下的只读参考副本。每次整理前全量刷新。 */
export function prepareReference(appRoot: string, shippedNotes: string, workflowsDir: string): void {
  const target = join(appRoot, '.ai-reference');
  mkdirSync(target, { recursive: true });
  const copy = (src: string, dst: string) => {
    if (!existsSync(src)) throw new Error(`参考副本的源不存在：${src}`);
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
  };
  copy(shippedNotes, join(target, 'notes'));
  copy(workflowsDir, join(target, 'workflows'));
}

const safeRel = (rel: string): boolean =>
  !rel.startsWith('/') && !rel.includes('\\')
  && rel.split('/').every((p) => p && p !== '.' && p !== '..');

/**
 * 用快照恢复档案和本机笔记。
 *
 * **快照文件是代理够得着的**（它在 data/ai-runs 下，而代理的 cwd 是 appRoot），
 * 所以里面的路径不能照单全收：档案路径必须仍在 appRoot 内，笔记相对路径不许带 `..`。
 * 档案写回**快照里那个用户**的位置，不是「现在切到的用户」——切了人再撤销，
 * 也不该把旧内容盖到新用户的档案上。
 */
export function restoreSnapshot(runDir: string, deps: AgentSnapshotDeps): void {
  const raw = JSON.parse(readFileSync(join(runDir, 'snapshot.json'), 'utf8')) as Snapshot;
  const profilePath = resolve(deps.appRoot, raw.profileRel);
  const rel = relative(deps.appRoot, profilePath);
  if (rel.startsWith('..') || resolve(deps.appRoot, rel) !== profilePath) {
    throw new Error('快照里的档案路径不在应用目录里，拒绝撤销');
  }

  rmSync(deps.localNotes, { recursive: true, force: true });
  mkdirSync(deps.localNotes, { recursive: true });
  for (const [noteRel, text] of Object.entries(raw.notes)) {
    if (!safeRel(noteRel)) throw new Error(`快照里的笔记路径不安全：${noteRel}`);
    const p = join(deps.localNotes, ...noteRel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileAtomic(p, text);
  }

  if (raw.profile === null) {
    if (existsSync(profilePath)) unlinkSync(profilePath);
  } else {
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileAtomic(profilePath, raw.profile);
  }
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function autoMarkersOk(profileFile: string): boolean {
  const text = readText(profileFile);
  if (text === null) return false;
  return countOf(text, BEGIN) === 1
    && countOf(text, END) === 1
    && text.indexOf(BEGIN) < text.indexOf(END);
}

function relevantWarnings(warnings: string[], changed: SnapshotDiff): string[] {
  const files = new Set(
    [...changed.added, ...changed.modified].map((p) => p.split('/').pop()).filter((x): x is string => !!x),
  );
  if (files.size === 0) return [];
  return warnings.filter((w) => [...files].some((f) => w.includes(f)));
}

const TASK_TEXT: Record<Exclude<AgentTask, 'custom'>, string> = {
  organize: '读当前用户的发音档案和统计，按「该补的笔记」一节整理：缺笔记的音补上、已有的补充；'
    + '先看已有笔记和参考副本，别重复造同主题的。',
  profile: '检查录音记录和现有笔记，更新当前用户档案的「已确认的习惯问题」「待观察」两节；'
    + '门槛见 workflows/agent.md，不够门槛的不要硬写。',
};

/**
 * 一次 AI 整理。同一时间只允许一个；跑完留下快照，可以整批撤销。
 *
 * 快照只覆盖**允许写的东西**（本机笔记 + 当前用户档案）。data/ 下其余文件在运行结束后
 * 会做一次差异检查，动了就列进 outOfScope——那些不撤销，只提醒人自己看。
 */
export class AgentRunner {
  private state: AgentStatus = {
    state: 'idle',
    logs: [],
    startedAt: null,
    finishedAt: null,
    changed: null,
    outOfScope: [],
    noteWarnings: [],
    autoOk: null,
    runId: null,
    error: null,
    cancelling: false,
  };
  private running = false;
  private cancelRequested = false;
  private childPid: number | undefined;
  private counter = 0;
  private lastSnapshot: Snapshot | null = null;
  private lastRunDir: string | null = null;
  private lastDb: Database.Database | null = null;

  constructor(private deps: AgentDeps, private opts: AgentRunnerOptions = {}) {}

  status(): AgentStatus {
    return {
      ...this.state,
      logs: [...this.state.logs],
      changed: this.state.changed
        ? {
          added: [...this.state.changed.added],
          modified: [...this.state.changed.modified],
          removed: [...this.state.changed.removed],
        }
        : null,
      outOfScope: this.state.outOfScope.map((x) => ({ ...x })),
      noteWarnings: [...this.state.noteWarnings],
    };
  }

  async run(task: AgentTask, note?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelRequested = false;
    this.state = {
      state: 'running',
      logs: [],
      startedAt: Date.now(),
      finishedAt: null,
      changed: null,
      outOfScope: [],
      noteWarnings: [],
      autoOk: null,
      runId: null,
      error: null,
      cancelling: false,
    };

    // 跑的过程中用户可能被切走。把「这次整理属于谁」在开头钉住，
    // 后面的快照、同步、撤销都只碰这一份。
    const deps: AgentSnapshotDeps = {
      appRoot: this.deps.appRoot,
      dataDir: this.deps.dataDir,
      localNotes: this.deps.localNotes,
      profileFile: this.deps.profileFile,
    };
    const db = this.deps.db;
    this.lastDb = db;
    let before: Snapshot | null = null;

    try {
      // 默认运行器只会走命令行。接口模式在这里就停住：快照、参考副本、同步档案
      // 一个都别做——一次注定不开始的整理不该在用户档案上留下任何改动。
      if (!this.opts.runAgent && readAiSettings(this.deps.dataDir).mode !== 'cli') {
        this.state.state = 'error';
        this.state.error = '整理需要命令行代理：接口模式只能讲解，不能读写文件。';
        return;
      }

      const taskText = task === 'custom' ? (note ?? '').trim() : TASK_TEXT[task];
      if (!taskText) throw new Error('自定义整理要有具体说明。');
      const userName = this.deps.userName();

      before = snapshotAllowed(deps);
      const runId = this.newRunId();
      const runDir = join(deps.dataDir, 'ai-runs', runId);
      mkdirSync(runDir, { recursive: true });
      writeFileAtomic(join(runDir, 'snapshot.json'), `${JSON.stringify(before, null, 2)}\n`);
      this.lastSnapshot = before;
      this.lastRunDir = runDir;
      this.state.runId = runId;

      this.log('正在铺参考副本');
      prepareReference(deps.appRoot, this.deps.shippedNotes, this.deps.workflowsDir);

      const prompt = buildAgentPrompt({
        ...deps,
        db,
        noteStore: this.deps.noteStore,
        workflowsDir: this.deps.workflowsDir,
        userName,
      }, taskText, task === 'custom' ? undefined : note);

      const runAgent: AgentRunFn = this.opts.runAgent ?? (async ({ cwd, prompt: p, onLog, onChild }) => {
        const settings = readAiSettings(this.deps.dataDir);
        if (settings.mode !== 'cli') {
          throw new Error('整理需要命令行代理：接口模式只能讲解，不能读写文件。');
        }
        const inv = resolveCliInvocation(settings, p, 'agent');
        const r = await runCliAgent(inv, { cwd, onLog, onChild });
        return { ...r, displayName: inv.displayName };
      });

      this.log('正在启动 AI 整理');
      let result: AgentRunResult;
      try {
        result = await runAgent({
          cwd: deps.appRoot,
          prompt,
          onLog: (line) => this.log(line),
          onChild: (pid) => {
            this.childPid = pid;
            if (this.cancelRequested) killTree(pid);
          },
        });
      } catch (e) {
        this.state.error = (e as Error).message;
        result = { code: null, output: '' };
      }

      // 越界检查必须在下面这些「我们自己写 DB/档案」的动作之前：
      // reconcile 会改 index.db、syncProfile 会改档案，晚一步就会把它们当成代理改的。
      this.state.outOfScope = this.detectOutOfScope(deps, before);
      const postWarnings = this.postProcess(deps, db);
      const after = snapshotAllowed(deps);
      this.state.changed = diffSnapshots(before, after);
      this.state.noteWarnings = [
        ...postWarnings,
        ...relevantWarnings(this.deps.noteStore.warnings, this.state.changed),
      ];
      this.state.autoOk = autoMarkersOk(deps.profileFile);

      if (this.cancelRequested) {
        this.state.state = 'cancelled';
        this.log('已取消整理');
      } else if (this.state.error) {
        this.state.state = 'error';
      } else if (result.code !== 0) {
        this.state.state = 'error';
        this.state.error = `${result.displayName ?? 'AI 代理'} 退出码 ${result.code ?? '未知'}`;
      } else {
        this.state.state = 'done';
        this.log('整理完成');
      }
    } catch (e) {
      this.state.state = 'error';
      this.state.error = (e as Error).message;
      if (before) {
        try {
          this.state.changed = diffSnapshots(before, snapshotAllowed(deps));
        } catch { /* 快照都算不出来时，至少把错误报出去 */ }
      }
    } finally {
      this.state.finishedAt = Date.now();
      this.state.cancelling = false;
      this.running = false;
      this.childPid = undefined;
    }
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelRequested = true;
    this.state.cancelling = true;
    this.log('已请求取消，正在停掉代理');
    killTree(this.childPid);
  }

  undo(): void {
    if (this.running) throw new Error('整理还在跑，等它结束再撤销。');
    if (!this.lastRunDir || !this.lastSnapshot) throw new Error('这一次还没有可撤销的整理。');
    const snap = this.lastSnapshot;
    const profilePath = resolve(this.deps.appRoot, snap.profileRel);

    restoreSnapshot(this.lastRunDir, {
      appRoot: this.deps.appRoot,
      dataDir: this.deps.dataDir,
      localNotes: this.deps.localNotes,
      profileFile: profilePath,
    });

    try {
      this.deps.noteStore.load();
    } catch (e) {
      this.state.noteWarnings = [...this.state.noteWarnings, `撤销后重扫笔记失败：${(e as Error).message}`];
    }
    const db = this.lastDb ?? this.deps.db;
    try {
      reconcileAttempts(db, this.deps.noteStore.all());
    } catch (e) {
      this.state.noteWarnings = [...this.state.noteWarnings, `撤销后重算笔记归属失败：${(e as Error).message}`];
    }
    try {
      syncProfile(profilePath, db, this.deps.noteStore, this.deps.now());
    } catch (e) {
      this.state.noteWarnings = [...this.state.noteWarnings, `撤销后同步发音档案失败：${(e as Error).message}`];
    }

    this.state.state = 'undone';
    this.state.finishedAt = Date.now();
    this.state.autoOk = autoMarkersOk(profilePath);
    this.log('已撤销这次整理');
  }

  private log(line: string): void {
    for (const part of line.split(/[\r\n]+/)) {
      const s = part.trimEnd();
      if (!s) continue;
      this.state.logs.push(s);
      if (this.state.logs.length > MAX_LOGS) this.state.logs.splice(0, this.state.logs.length - MAX_LOGS);
    }
  }

  private postProcess(deps: AgentSnapshotDeps, db: Database.Database): string[] {
    const warnings: string[] = [];
    try {
      this.deps.noteStore.load();
    } catch (e) {
      warnings.push(`重扫笔记失败：${(e as Error).message}`);
    }
    try {
      reconcileAttempts(db, this.deps.noteStore.all());
    } catch (e) {
      warnings.push(`重算笔记归属失败：${(e as Error).message}`);
    }
    try {
      syncProfile(deps.profileFile, db, this.deps.noteStore, this.deps.now());
    } catch (e) {
      warnings.push(`同步发音档案失败：${(e as Error).message}`);
    }
    return warnings;
  }

  private detectOutOfScope(deps: AgentSnapshotDeps, before: Snapshot): OutOfScope[] {
    const after = dataBaseline(deps.dataDir);
    const profileRel = relTo(deps.dataDir, resolve(deps.appRoot, before.profileRel));
    const notesRel = relTo(deps.dataDir, deps.localNotes).replace(/\/+$/, '');
    // 新增的笔记在运行前并不存在，所以不能只拿 before.notes 的键当白名单；
    // 整个笔记目录都是允许写的，档案只有那一个文件。
    const allowed = (rel: string) =>
      rel === profileRel || rel === notesRel || (!!notesRel && rel.startsWith(`${notesRel}/`));
    const out: OutOfScope[] = [];
    const keys = new Set([...Object.keys(before.data), ...Object.keys(after)]);
    for (const rel of keys) {
      if (allowed(rel)) continue;
      const a = before.data[rel];
      const b = after[rel];
      if (a === b) continue;
      const kind = a === undefined ? 'added' : b === undefined ? 'removed' : 'modified';
      out.push({ path: joinRel(before.dataDirRel, rel), kind });
    }
    return out.sort((x, y) => x.path.localeCompare(y.path, 'zh'));
  }

  private newRunId(): string {
    const stamp = this.deps.now().replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '') || 'run';
    let id = '';
    do {
      id = `${stamp}-${++this.counter}`;
    } while (existsSync(join(this.deps.dataDir, 'ai-runs', id)));
    return id;
  }
}
