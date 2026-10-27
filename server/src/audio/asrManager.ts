import { spawn as spawnChild, spawnSync, type ChildProcess } from 'node:child_process';
import { buildAsrCommand, uvVersionProblem } from './asrCommand.js';
import { isPortListening, pickFreePort } from '../net.js';

export type AsrState = 'off' | 'no-uv' | 'starting' | 'ready' | 'error';

export interface AsrStatus {
  state: AsrState;
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
  probeUv: () => { found: boolean; output: string };
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

export class AsrManager {
  private state: AsrState = 'off';
  private portNo: number | null = null;
  private uvFound = false;
  private startedAt: number | null = null;
  private error: string | null = null;
  private log: string[] = [];
  private child: ChildProcess | null = null;
  private runId = 0;
  private stopping = false;

  constructor(private o: AsrManagerOptions) {}

  status(): AsrStatus {
    return {
      state: this.state,
      port: this.portNo,
      uvFound: this.uvFound,
      startedAt: this.startedAt,
      error: this.error,
      log: [...this.log],
    };
  }

  port(): number | null { return this.portNo; }

  private push(text: string): void {
    for (const line of text.replace(ANSI, '').split(/[\r\n]+/)) {
      const s = line.trimEnd();
      if (!s) continue;
      this.log.push(s);
      if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.error = null;
    if (!this.o.autostart) { this.state = 'off'; return; }

    const uv = this.o.probeUv();
    this.uvFound = uv.found;
    if (!uv.found) { this.state = 'no-uv'; return; }
    const bad = uvVersionProblem(uv.output);
    if (bad) {
      this.state = 'error';
      this.error = bad;
      this.push(bad);
      return;
    }

    const fetchFn = this.o.fetch ?? fetch;
    const listening = this.o.isListening ?? isPortListening;
    const explicit = this.o.explicitPort;

    // 显式端口：有人在听 → 先问一句是不是我们的边车。
    // 判据不能只看 /health 的 ok：模型加载期间端口可能在听、而 ok 还是 false。
    if (explicit !== null && await listening(explicit, '127.0.0.1')) {
      try {
        const r = await fetchFn(`http://127.0.0.1:${explicit}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await r.json() as { ok?: unknown };
        if (typeof body.ok === 'boolean') {
          this.portNo = explicit;
          this.state = 'starting';
          this.startedAt = (this.o.now ?? Date.now)();
          void this.waitReady(explicit, ++this.runId);
          return;
        }
      } catch { /* 不是我们的服务，落到下面报错 */ }
      this.state = 'error';
      this.error = `端口 ${explicit} 被别的程序占着。关掉它，或在 .env 里换一个 ASR_PORT。`;
      this.push(this.error);
      return;
    }

    const port = explicit ?? await (this.o.pickPort ?? pickFreePort)();
    this.portNo = port;
    this.startedAt = (this.o.now ?? Date.now)();
    const cmd = buildAsrCommand({
      uvPath: this.o.uvPath,
      projectDir: this.o.projectDir,
      port,
      dataDir: this.o.dataDir,
      baseEnv: this.o.baseEnv ?? process.env,
    });

    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? spawnChild)(cmd.command, cmd.args, {
        env: cmd.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.state = 'error';
      this.error = `起不了识别服务：${(e as Error).message}`;
      this.push(this.error);
      return;
    }

    this.child = child;
    this.state = 'starting';
    const id = ++this.runId;
    child.stdout?.on('data', (b: Buffer) => this.push(b.toString()));
    child.stderr?.on('data', (b: Buffer) => this.push(b.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (id !== this.runId || this.stopping) return;
      this.runId += 1;
      this.state = 'error';
      this.error = `起不了识别服务：${e.message}`;
      this.push(this.error);
    });
    child.on('exit', (code) => {
      if (id !== this.runId || this.stopping) return;
      this.runId += 1;
      this.state = 'error';
      this.error = `识别服务退出了（退出码 ${code ?? '未知'}）。日志里最后几行通常能看出原因。`;
      this.push(this.error);
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
        if (body.ok === true) { this.state = 'ready'; return; }
      } catch { /* 还没起来，继续等 */ }
      await sleep(1000);
    }
  }

  stop(): void {
    if (this.stopping && this.child === null) { this.state = 'off'; return; }
    this.stopping = true;
    this.runId += 1;
    const pid = this.child?.pid;
    try { this.child?.kill(); } catch { /* 已经退了 */ }
    if (pid) (this.o.killTree ?? defaultKillTree)(pid);
    this.child = null;
    this.state = 'off';
  }

  async restart(): Promise<void> {
    this.stop();
    this.state = 'off';
    await this.start();
  }
}

export function defaultKillTree(pid: number): void {
  if (process.platform === 'win32') {
    // 同步执行，退出流程里没时间等 Promise
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ } }
}
