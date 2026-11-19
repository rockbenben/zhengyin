import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stopChildTree } from '../processTree.js';
import { buildAsrCommand, uvVersionProblem } from './asrCommand.js';
import { isPortListening, pickFreePort } from '../net.js';

export type AsrState = 'off' | 'no-uv' | 'starting' | 'ready' | 'error';

export interface AsrStatus {
  state: AsrState;
  stage: 'dependencies' | 'model' | null;
  stalled: boolean;
  port: number | null;
  uvFound: boolean;
  startedAt: number | null;
  error: string | null;
  log: string[];
}

export interface AsrManagerOptions {
  projectDir: string;
  uvPath: string;
  dataDir: string;
  explicitPort: number | null;
  autostart: boolean;
  /** .env 里的 MODEL_SOURCE / HF_ENDPOINT 等，由调用方合并进来 */
  baseEnv?: NodeJS.ProcessEnv;
  probeUv: (signal: AbortSignal) => { found: boolean; output: string } | Promise<{ found: boolean; output: string }>;
  pickPort?: () => Promise<number>;
  isListening?: (port: number, host: string) => Promise<boolean>;
  fetch?: typeof fetch;
  spawn?: typeof spawnChild;
  killTree?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_LOG = 300;
const ANSI = /\u001b\[[0-9;]*m/g;
const MODEL_START = '[zhengyin-asr] model';
const PARENT_PING = '[zhengyin-asr] parent-ping';
const STALL_WARNING_MS = 2 * 60_000;
const STALL_TIMEOUT_MS = 10 * 60_000;
const STARTUP_TIMEOUT_MS = 45 * 60_000;
const MODEL_READY_POLL_MS = 250;

export class AsrManager {
  private state: AsrState = 'off';
  private portNo: number | null = null;
  private uvFound = false;
  private startedAt: number | null = null;
  private stage: AsrStatus['stage'] = null;
  private lastProgressAt = 0;
  private error: string | null = null;
  private log: string[] = [];
  private probe: AbortController | null = null;
  private child: ChildProcess | null = null;
  private runId = 0;
  private stopping = false;
  private restartInFlight: Promise<void> | null = null;

  constructor(private o: AsrManagerOptions) {}

  status(): AsrStatus {
    return {
      state: this.state,
      stage: this.stage,
      stalled: this.state === 'starting' && this.now() - this.lastProgressAt >= STALL_WARNING_MS,
      port: this.portNo,
      uvFound: this.uvFound,
      startedAt: this.startedAt,
      error: this.error,
      log: [...this.log],
    };
  }

  port(): number | null { return this.portNo; }

  private now(): number { return (this.o.now ?? Date.now)(); }

  private push(text: string): void {
    const line = text.replace(ANSI, '').trimEnd();
    if (!line || line === this.log.at(-1)) return;
    this.lastProgressAt = this.now();
    this.log.push(line);
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  private startupTask(): string {
    return this.stage === 'dependencies' ? '安装识别依赖' : '加载识别模型';
  }

  private fail(error: string): void {
    this.runId += 1;
    this.state = 'error';
    this.stage = null;
    this.error = error;
    this.push(error);
  }

  async start(): Promise<void> {
    const id = ++this.runId;
    this.stopping = false;
    this.error = null;
    this.portNo = null;
    this.startedAt = null;
    this.stage = null;
    this.log = [];
    if (!this.o.autostart) { this.state = 'off'; return; }

    this.state = 'starting';
    this.startedAt = this.lastProgressAt = this.now();

    const probe = new AbortController();
    this.probe = probe;
    try {
      const uv = await this.o.probeUv(probe.signal);
      if (id !== this.runId) return;
      this.uvFound = uv.found;
      if (!uv.found) { this.state = 'no-uv'; return; }
      const bad = uvVersionProblem(uv.output);
      if (bad) { this.fail(bad); return; }
      this.stage = 'dependencies';
      await this.launch(id);
    } catch (error) {
      if (id === this.runId) this.fail(`无法启动识别服务：${(error as Error).message}`);
    } finally {
      if (this.probe === probe) this.probe = null;
    }
  }

  private async launch(id: number): Promise<void> {
    const fetchFn = this.o.fetch ?? fetch;
    const listening = this.o.isListening ?? isPortListening;
    const explicit = this.o.explicitPort;

    // 显式端口：有人在听 → 先问一句是不是我们的边车。
    // 判据不能只看 /health 的 ok：模型加载期间端口可能在听、而 ok 还是 false。
    const occupied = explicit !== null && await listening(explicit, '127.0.0.1');
    if (id !== this.runId) return;
    if (occupied) {
      try {
        const r = await fetchFn(`http://127.0.0.1:${explicit}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await r.json() as { ok?: unknown };
        if (id !== this.runId) return;
        if (typeof body.ok === 'boolean') {
          this.portNo = explicit;
          this.stage = 'model';
          this.lastProgressAt = this.now();
          void this.waitReady(explicit, id);
          return;
        }
      } catch { /* 不是我们的服务，落到下面报错 */ }
      if (id !== this.runId) return;
      this.fail(`端口 ${explicit} 被别的程序占着。关掉它，或在 .env 里换一个 ASR_PORT。`);
      return;
    }

    const port = explicit ?? await (this.o.pickPort ?? pickFreePort)();
    if (id !== this.runId) return;
    this.portNo = port;
    const cmd = buildAsrCommand({
      uvPath: this.o.uvPath,
      projectDir: this.o.projectDir,
      port,
      dataDir: this.o.dataDir,
      baseEnv: this.o.baseEnv ?? process.env,
    });

    const child = (this.o.spawn ?? spawnChild)(cmd.command, cmd.args, {
      env: { ...cmd.env, ZHENGYIN_ASR_PARENT_PIPE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line: string) => {
        if (id !== this.runId || line === PARENT_PING) return;
        if (line === MODEL_START) {
          this.stage = 'model';
          this.lastProgressAt = this.now();
        } else {
          this.push(line);
        }
      });
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (id !== this.runId) return;
      this.fail(`无法启动识别服务：${e.message}`);
    });
    child.on('close', (code, signal) => {
      if (id !== this.runId) return;
      const task = this.state === 'starting' ? `${this.startupTask()}失败` : '识别服务已退出';
      this.child = null;
      this.fail(`${task}（${signal ?? `退出码 ${code ?? '未知'}`}）。请查看识别服务日志后重试。`);
    });
    void this.waitReady(port, id);
  }

  private async waitReady(port: number, id: number): Promise<void> {
    const fetchFn = this.o.fetch ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while (id === this.runId && !this.stopping) {
      try {
        const r = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        const body = await r.json() as { ok?: unknown };
        if (id !== this.runId) return;
        if (r.ok && body.ok === true) {
          this.state = 'ready';
          this.stage = null;
          return;
        }
      } catch { /* 还没起来，继续等 */ }
      if (id !== this.runId) return;
      const now = this.now();
      const inactive = now - this.lastProgressAt >= STALL_TIMEOUT_MS;
      if (inactive || (this.startedAt !== null && now - this.startedAt >= STARTUP_TIMEOUT_MS)) {
        const duration = inactive ? '已 10 分钟没有进展' : '启动已超过 45 分钟';
        const error = `${this.startupTask()}超时（${duration}）。请检查网络和磁盘空间，查看日志后重启识别服务。`;
        this.fail(error);
        this.stopOwnedChild();
        return;
      }
      await sleep(this.stage === 'model' && now - this.lastProgressAt < STALL_WARNING_MS
        ? MODEL_READY_POLL_MS
        : 1000);
    }
  }

  private stopOwnedChild(): void {
    const child = this.child;
    this.child = null;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      (this.o.killTree ?? stopChildTree)(child.pid);
    }
  }

  stop(): void {
    this.restartInFlight = null;
    this.stopping = true;
    this.runId += 1;
    this.probe?.abort();
    this.stopOwnedChild();
    this.stage = null;
    this.state = 'off';
  }

  restart(): Promise<void> {
    if (this.restartInFlight) return this.restartInFlight;
    this.stop();
    const pending = this.start().finally(() => {
      if (this.restartInFlight === pending) this.restartInFlight = null;
    });
    this.restartInFlight = pending;
    return pending;
  }
}
