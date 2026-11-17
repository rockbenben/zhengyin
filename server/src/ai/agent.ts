import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { NoteStore } from '../notes.js';
import { BEGIN, END, syncProfile } from '../profile.js';
import { reconcileAttempts } from '../reconcile.js';
import { openDb } from '../db.js';
import { writeFileAtomic } from '../atomic.js';
import { readAiSettings } from './settings.js';
import { agentBoundaryError, killTree, resolveCliInvocation, runCliAgent } from './cli.js';
import { prepareAgentWorkspace, commitAgentWorkspace, undoProfileSections, type ProfileChange } from './staging.js';
import { buildAgentPrompt } from './context.js';
import { aiStatus, runAiText } from './run.js';
import { buildPlanMessages, stagePlan } from './plan.js';

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
  /** data/ 的基线（排除缓存和运行记录）：相对路径 → 内容 hash。只用于越界检测 */
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

/** `cwd` 与 `prompt` 只给注入的假实现用；默认实现按模式自己准备工作副本和提示词，不看这两个字段。 */
export interface AgentRunArgs {
  cwd: string;
  prompt: string;
  onLog: (line: string) => void;
  onChild: (pid: number | undefined) => void;
}
export type AgentRunResult = { code: number | null; output: string; displayName?: string };
export type AgentRunFn = (args: AgentRunArgs) => Promise<AgentRunResult>;
export interface AgentRunnerOptions { runAgent?: AgentRunFn; runText?: typeof runAiText }

/** app.ts 只依赖这四个动作；测试注入的假实现不用碰进程和文件。 */
export interface AgentController {
  run(task: AgentTask, note?: string): Promise<void>;
  status(): AgentStatus;
  cancel(): void;
  undo(): void;
}

const posix = (p: string): string => p.split(sep).join('/');
const relTo = (root: string, p: string): string => posix(relative(root, p));
const joinRel = (a: string, b: string): string => (a ? `${a.replace(/\/+$/, '')}/${b}` : b);
const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex');

const EXCLUDED_TOP = new Set(['audio', 'models', 'asr', 'ai-runs', 'ai-workspace', 'stop-control']);
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

/** 把随附笔记与提示词复制到 appRoot 下的只读参考副本（先删后拷）。只在测试注入 runAgent 时铺；生产由 staging 在命令行整理的工作副本里铺，接口整理不铺。 */
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
 * 用快照恢复本机笔记，按提交记录恢复档案小节。注入的旧测试入口仍走档案快照。
 *
 * `snapshot` 是运行前的状态，`after` 是这次整理提交后的状态：只有两者不同的文件才算
 * 整理动过，也才可能回滚。运行结束之后又被改过的文件不覆盖——保留后来的编辑，
 * 并在返回的冲突告警里点名。
 *
 * **不读 `data/ai-runs` 下的 snapshot.json**：命令行代理的 cwd 就在 `data/ai-runs/<runId>/workspace`，上一层的那个文件它够得着。
 * 拿磁盘上的 JSON 决定「删哪些笔记、还原哪份档案」，等于把撤销交给被撤销的对象。
 * 撤销只用进程里这两份快照（`AgentRunner.lastSnapshot` / `lastAfter`）——重启后本来也没有撤销入口。
 *
 * 档案路径仍然要校验在 appRoot 内、笔记相对路径不许带 `..`；写回**快照里那个用户**
 * 的位置，不是「现在切到的用户」——切了人再撤销，也不该把旧内容盖到新用户的档案上。
 */
function restoreFromSnapshot(snapshot: Snapshot, after: Snapshot, deps: AgentSnapshotDeps, profileChanges: ProfileChange[] | null): string[] {
  const conflicts: string[] = [];
  const profilePath = resolve(deps.appRoot, snapshot.profileRel);
  const rel = relative(deps.appRoot, profilePath);
  if (rel.startsWith('..') || resolve(deps.appRoot, rel) !== profilePath) {
    throw new Error('快照里的档案路径不在应用目录里，拒绝撤销');
  }

  const current = snapshotAllowed(deps);
  const changed = new Set([...Object.keys(snapshot.notes), ...Object.keys(after.notes)]);
  for (const noteRel of changed) {
    if (!safeRel(noteRel)) throw new Error(`快照里的笔记路径不安全：${noteRel}`);
    if (snapshot.notes[noteRel] === after.notes[noteRel]) continue;
    if (current.notes[noteRel] !== after.notes[noteRel]) { conflicts.push(`保留后续编辑：${noteRel}`); continue; }
    const p = join(deps.localNotes, ...noteRel.split('/'));
    if (snapshot.notes[noteRel] === undefined) {
      if (existsSync(p)) unlinkSync(p);
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileAtomic(p, snapshot.notes[noteRel]);
    }
  }
  if (profileChanges !== null) {
    conflicts.push(...undoProfileSections(profilePath, profileChanges));
  } else if (snapshot.profile !== after.profile) {
    if (current.profile !== after.profile) conflicts.push('保留档案的后续编辑');
    else if (snapshot.profile === null) {
      if (existsSync(profilePath)) unlinkSync(profilePath);
    } else {
      mkdirSync(dirname(profilePath), { recursive: true });
      writeFileAtomic(profilePath, snapshot.profile);
    }
  }
  return conflicts;
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
 * 一次 AI 整理。同一时间只允许一个；跑完留下快照，可以撤销这次提交的改动（之后又被改过的文件保留后来的编辑）。
 *
 * 快照只覆盖**允许写的东西**（本机笔记 + 当前用户档案）。data/ 下其余文件在运行结束后
 * 会做一次差异检查，动了就列进 outOfScope——那些不撤销，只提醒人自己看。
 */
export class AgentRunner implements AgentController {
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
  private lastAfter: Snapshot | null = null;
  private lastProfileChanges: ProfileChange[] = [];
  private lastDb: Database.Database | null = null;
  private apiAbort: AbortController | null = null;

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
    const submittedNotes = new Set<string>();

    try {
      const settings = readAiSettings(this.deps.dataDir);
      if (!this.opts.runAgent) {
        if (!settings.consent) throw new Error('请先在设置中同意使用 AI 整理资料。');
        const reason = settings.mode === 'cli' ? agentBoundaryError(settings.cli.kind)
          : aiStatus(settings, () => false).reason;
        if (reason) throw new Error(reason);
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
      this.lastAfter = null;
      this.lastProfileChanges = [];
      this.state.runId = runId;

      this.log('正在准备整理工作副本');
      if (this.opts.runAgent) prepareReference(deps.appRoot, this.deps.shippedNotes, this.deps.workflowsDir);

      const prompt = buildAgentPrompt({
        ...deps,
        db,
        noteStore: this.deps.noteStore,
        userName,
      }, taskText, task === 'custom' ? undefined : note);

      const runAgent: AgentRunFn = this.opts.runAgent ?? (async ({ cwd, prompt: p, onLog, onChild }) => {
        // 只有命令行整理需要文件形态的参考副本；接口整理的资料直接拼进消息，不铺 .ai-reference。
        const staged = prepareAgentWorkspace(join(runDir, 'workspace'), deps, this.deps.shippedNotes, this.deps.workflowsDir, settings.mode === 'cli');
        let r: AgentRunResult;
        if (settings.mode === 'api') {
          const messages = buildPlanMessages(before!, this.deps.noteStore, staged, this.deps.workflowsDir, taskText, userName);
          const reservedIds = new Set(this.deps.noteStore.all().map(n => n.id));
          this.apiAbort = new AbortController();
          if (this.cancelRequested) this.apiAbort.abort();
          onLog('正在请求整理方案；返回后由应用检查并保存');
          const response = await (this.opts.runText ?? runAiText)(settings, messages, { signal: this.apiAbort.signal, maxTokens: 8192 });
          if (this.cancelRequested) return { code: null, output: '' };
          const summary = stagePlan(response.text, staged, before!, reservedIds);
          if (summary) onLog(summary);
          r = { code: 0, output: summary, displayName: response.provider };
        } else {
          const stagedPrompt = buildAgentPrompt({ ...staged, db, noteStore: this.deps.noteStore, userName }, taskText, task === 'custom' ? undefined : note);
          const inv = resolveCliInvocation(settings, stagedPrompt, 'agent');
          r = { ...await runCliAgent(inv, { cwd: staged.appRoot, onLog, onChild }), displayName: inv.displayName };
        }
        if (r.code === 0 && !this.cancelRequested) {
          if (this.deps.db !== db || this.deps.profileFile !== deps.profileFile) throw new Error('整理期间用户已切换，本次改动未保存。');
          commitAgentWorkspace(staged, deps, before!, name => submittedNotes.add(name), changes => {
            this.lastProfileChanges = changes;
          });
        }
        return r;
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
        if (!this.cancelRequested) this.state.error = (e as Error).message;
        result = { code: null, output: '' };
      }

      // 越界检查必须在下面这些「我们自己写 DB/档案」的动作之前：
      // reconcile 会改 index.db、syncProfile 会改档案，晚一步就会把它们当成代理改的。
      this.state.outOfScope = this.detectOutOfScope(deps, before);
      const postWarnings = this.opts.runAgent || (result.code === 0 && !this.cancelRequested)
        || submittedNotes.size > 0 || this.lastProfileChanges.length > 0 ? this.postProcess(deps, db) : [];
      const after = snapshotAllowed(deps);
      this.lastAfter = this.opts.runAgent ? after : {
        ...before,
        notes: { ...before.notes },
      };
      if (!this.opts.runAgent) for (const name of submittedNotes) {
        if (after.notes[name] === undefined) delete this.lastAfter.notes[name];
        else this.lastAfter.notes[name] = after.notes[name];
      }
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
          const after = snapshotAllowed(deps);
          this.lastAfter = this.opts.runAgent ? after : { ...before, notes: { ...before.notes } };
          if (!this.opts.runAgent) for (const name of submittedNotes) {
            if (after.notes[name] === undefined) delete this.lastAfter.notes[name];
            else this.lastAfter.notes[name] = after.notes[name];
          }
          this.state.changed = diffSnapshots(before, snapshotAllowed(deps));
        } catch { /* 快照都算不出来时，至少把错误报出去 */ }
      }
    } finally {
      this.state.finishedAt = Date.now();
      this.state.cancelling = false;
      this.running = false;
      this.childPid = undefined;
      this.apiAbort = null;
    }
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelRequested = true;
    this.state.cancelling = true;
    this.apiAbort?.abort();
    this.log('已请求取消，正在停掉这次整理');
    killTree(this.childPid);
  }

  undo(): void {
    if (this.running) throw new Error('整理还在跑，等它结束再撤销。');
    if (!this.lastSnapshot || !this.lastAfter) throw new Error('这一次还没有可撤销的整理。');
    const snap = this.lastSnapshot;
    const profilePath = resolve(this.deps.appRoot, snap.profileRel);
    // 撤销之后，上一次运行留下的笔记告警已经随着文件一起回滚了；
    // 只保留撤销本身可能报出来的新问题。
    this.state.noteWarnings = [];
    this.state.error = null;

    this.state.noteWarnings = restoreFromSnapshot(snap, this.lastAfter, {
      appRoot: this.deps.appRoot,
      dataDir: this.deps.dataDir,
      localNotes: this.deps.localNotes,
      profileFile: profilePath,
    }, this.opts.runAgent ? null : this.lastProfileChanges);

    try {
      this.deps.noteStore.load();
    } catch (e) {
      this.state.noteWarnings = [...this.state.noteWarnings, `撤销后重扫笔记失败：${(e as Error).message}`];
    }
    const originalDb = this.lastDb ?? this.deps.db;
    const reopened = !originalDb.open;
    const db = reopened ? openDb(originalDb.name) : originalDb;
    try {
      reconcileAttempts(db, this.deps.noteStore.all());
    } catch (e) {
      this.state.noteWarnings = [...this.state.noteWarnings, `撤销后重算笔记归属失败：${(e as Error).message}`];
    }
    try {
      syncProfile(profilePath, db, this.deps.noteStore, this.deps.now());
    } catch (e) {
      this.state.noteWarnings = [...this.state.noteWarnings, `撤销后同步发音档案失败：${(e as Error).message}`];
    } finally {
      if (reopened) db.close();
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
