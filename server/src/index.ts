import { serve } from '@hono/node-server';
import { exec } from 'node:child_process';
import type { Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import dayjs from 'dayjs';
import 'dotenv/config';
import { serverPort } from './port.js';
import { createApp } from './app.js';
import { openDb, getEntry } from './db.js';
import { NoteStore } from './notes.js';
import { fetchMwAudio, verifyMwKey } from './audio/mw.js';
import { recognizePhonemes, checkPhonemeAsr, hasUv } from './audio/phonemeAsr.js';
import { synthesizeTts } from './audio/tts.js';
import { ReviewStore } from './review.js';
import { readEnvFile, readEnvValue } from './envfile.js';
import { syncProfile } from './profile.js';
import { reanalyzeEntries } from './reanalyze.js';
import { reconcileAttempts } from './reconcile.js';
import { missingFromTable, missingHowTo } from './analysis/articulation.js';

// 兼容从仓库根（npm start / npm run dev）或从 server/ 内部启动两种情况
const root = existsSync(join(process.cwd(), 'notes')) ? process.cwd() : join(process.cwd(), '..');
const dataDir = join(root, 'data');
mkdirSync(join(dataDir, 'audio'), { recursive: true });

// 发音部位表漏了音素的话，界面上那个音的部位尺会静静地不画——不报错、不崩，只是空着。
// 跟 notes.ts 的 validateTriggers 一样，把这种无声失效在启动时喊出来。
const missingArticulation = missingFromTable();
if (missingArticulation.length > 0) {
  console.warn(`[articulation] 这些音素还没进发音部位表，界面上它们的部位尺画不出来：${missingArticulation.join(' ')}`);
}
const missingHow = missingHowTo();
if (missingHow.length > 0) {
  console.warn(`[articulation] 这些音素还没写"怎么发"，发错时界面给不出指导：${missingHow.join(' ')}`);
}

const review = new ReviewStore(join(root, 'review-state.json'));
const noteStore = new NoteStore(join(root, 'notes'));
noteStore.load();

const db = openDb(join(dataDir, 'index.db'));

// 词条的推导结果是入库那一刻算好存下的，分析器加了新规则不会回溯——
// 实测 judge /dʒʌdʒ/ 该有 final-voiced 却没有，因为它是那个标签出现之前入库的。
// 这里按当前规则重算一遍（只碰"每个词都在词典里"的，理由见 reanalyze.ts）。
const re = reanalyzeEntries(db);
if (re.refreshed.length > 0) {
  console.log(`[entries] 按当前的分析规则更新了 ${re.refreshed.length} 个词条的音素标签`
    + `（共 ${re.checked} 个）：${re.refreshed.slice(0, 8).join('、')}${re.refreshed.length > 8 ? '…' : ''}`);
}

// 笔记归属（attempt_note）是**派生**的：错误行 + 这次念的词 + 当前的 notes/ 就能算出来。
// 它决定界面上那个「录音里反复出现」，而匹配规则改过好几轮——不对账的话，
// 界面上说的是按老规矩算的。判据只有一处（judge.ts 的 explainersFor）。
const rec = reconcileAttempts(db, noteStore.all());
if (rec.changed.length > 0) {
  const sample = rec.changed.slice(0, 3).map((c) =>
    `${c.target}${c.added.length ? ` +${c.added.join(' ')}` : ''}${c.removed.length ? ` -${c.removed.join(' ')}` : ''}`);
  console.log(`[attempts] 按当前的匹配规则重算了 ${rec.changed.length} 次录音的笔记归属`
    + `（共 ${rec.checked} 次）：${sample.join('，')}${rec.changed.length > 3 ? ' …' : ''}`);
}
if (rec.skipped > 0) {
  console.warn(`[attempts] ${rec.skipped} 次录音的词现在词典里查不到了，归属没敢动`);
}

const profileFile = join(root, '发音档案.md');

// ── 档案是**本机的**，模板才进版本库 ──
//
// 里面是这台机器的统计，跟着仓库发出去的话新用户读到的是别人的数据，
// 而约定让 AI「每次纠音前先读这里」。它还每次运行都被重写，跟踪它会让
// 每个人的工作区永远是脏的。
//
// 所以第一次启动时从模板铺一份。**不能让 syncProfile 自己创建**：
// 它只写统计块，手写的那几节会整个丢掉，而 AI 的工作流依赖那几节。
if (!existsSync(profileFile)) {
  const template = join(root, '发音档案.template.md');
  if (existsSync(template)) {
    copyFileSync(template, profileFile);
    console.log('[profile] 已从模板生成 发音档案.md');
  }
}

/**
 * 把评测统计同步进发音档案。
 *
 * 只在评测成功后同步一次的话，三种情况档案会停在旧数据：写完一篇笔记、
 * 手工改过数据库、服务没开的时候动了上面两样。而这份档案正是下次对话时
 * AI 会读的东西，停在旧数据等于喂它过期信息。
 * 所以：启动时同步 + 笔记一变就同步 + 每次评测后同步。失败只警告不中断。
 */
function refreshProfile(reason: string): void {
  try {
    syncProfile(profileFile, db, noteStore, new Date().toISOString());
  } catch (e) {
    console.warn(`[profile] 同步发音档案失败（${reason}）：${(e as Error).message}`);
  }
}

// 孤儿复习卡：指向一个已经不存在的词条。它每天都会出现在复习页、每天被跳过，
// 而 advance() 只从本地队列去掉它、不动文件——于是永远卡在那儿，用户没有任何手段清掉。
// 来源：手工改过 review-state.json（那个文件本来就是给人看、给人改的，见 review.ts）。
const orphans = review.dueAll().filter((text) => !getEntry(db, text));
for (const text of orphans) review.removeCard(text);
if (orphans.length > 0) {
  console.warn(`[review] 清掉 ${orphans.length} 张指向不存在词条的复习卡：${orphans.join(' ')}`);
}

refreshProfile('启动');
noteStore.watch(() => refreshProfile('笔记有变动'));

const app = createApp({
  db,
  noteStore,
  audioDir: join(dataDir, 'audio'),
  // dotenv 按 cwd 找 .env，而本进程可能从仓库根也可能从 server/ 启动；
  // 这里以解析出来的 root 为准再兜一次，避免"明明配了却说没配"。
  mwKey: process.env.MW_API_KEY || readEnvValue(readEnvFile(join(root, '.env')), 'MW_API_KEY') || undefined,
  fetchMw: fetchMwAudio,
  synthTts: synthesizeTts,
  now: () => new Date().toISOString(),
  review,
  today: () => dayjs().format('YYYY-MM-DD'),
  modelsDir: join(dataDir, 'models'),
  envFile: join(root, '.env'),
  root,
  verifyMw: verifyMwKey,
  recognizePhonemes,
  checkPhonemeAsr,
  // 启动时查一次就够：边车是启动脚本拉起来的，中途装上 uv 也得重启
  hasUv: hasUv(),
  profileFile,
});

// 生产单进程托管：npm run build 产出 web/dist 后，同一个进程既提供 /api/* 又直接
// 托管前端静态文件，SPA 路由（/word/:text、/review 等）刷新或直接输入网址也要能打开，
// 不能 404——所以未命中静态文件时 fallback 回 index.html，由前端路由器接管。
// 开发模式（npm run dev）不产出 web/dist（前端走 vite 自己的 5173），这段整体跳过，
// 不影响 /api/* 正常工作。
// /api/* 的路由已经在 createApp() 里注册在前面，命中的请求在到达这里之前就已经
// 结束（不会 next() 下来）；只有真正未知的路径才会落到下面这段。未知的 /api/* 显式
// 返回 JSON 404，避免被 SPA fallback 误吞成 index.html。
const webDist = join(root, 'web', 'dist');
if (existsSync(webDist)) {
  // SPA 外壳绝不能被缓存。它里面写死了带哈希的资源文件名；浏览器一旦缓存了旧的一份，
  // 重新构建之后拿到的仍是旧 HTML → 指向旧资源 → 新页面永远看不到（新增的「设置」入口
  // 就是这么消失的）。资源本身带内容哈希，缓存多久都无所谓，坏就坏在这张外壳上。
  const shell = (c: Context) =>
    c.html(readFileSync(join(webDist, 'index.html'), 'utf8'), 200, {
      'Cache-Control': 'no-store, must-revalidate',
    });

  // `/` 必须抢在 serveStatic 前面：静态中间件会把目录请求直接映射到 index.html 并原样
  // 返回，那条路径上加不了响应头——于是最常用的入口恰恰是唯一还会被缓存的那个。
  app.get('/', shell);
  app.use('/*', serveStatic({ root: webDist }));
  app.get('*', (c) => {
    // /api/* 的路由已在 createApp() 里注册在前面，命中的请求到不了这儿；只有真正未知的
    // /api/* 会落下来，显式回 JSON 404，避免被 SPA fallback 误吞成 index.html。
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
    return shell(c);
  });
}

/**
 * 端口。
 *
 * 选 30031 是因为 3000 上下太热闹（Node 默认 3000、Vite 5173、脚手架 3001/8080）。
 * 挑端口的约束：别落进 Windows 临时端口范围（49152 起）、别落进浏览器的
 * ERR_UNSAFE_PORT 黑名单、30000–49151 这段基本没人用。边车是 30032。
 *
 * 换端口在 `.env` 里写 `PORT=30041`。**不要教人写 `PORT=30041 npm start`**——
 * 那是 POSIX shell 语法，Windows 的 cmd 和 PowerShell 都跑不通，
 * 而这个提示唯一会出现的场合正好就是 Windows。
 *
 * 端口被占最常见的占用者是上次没关掉的同一个应用，那时正确的反应不是换端口，
 * 是告诉你"已经在跑了"。
 */
const port = serverPort();
const url = `http://localhost:${port}`;

/** 占着这个端口的是不是本应用自己 */
async function alreadyOurs(): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && ((await r.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

// serve() 是**异步** listen，EADDRINUSE 以 'error' 事件到达、不会同步抛出——
// 包 try/catch 抓不到它，进程会以未捕获异常收场（这段会话里就这么崩过一次）。
// 必须挂在返回的 server 上。
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`正音 ${url}`);
  // ── 「怎么停」必须在这儿说，不能交给启动脚本 ──
  //
  // 写在启动脚本里要维护三份，还盖不住 `npm start` 之外的用法。而且原来那句只在
  // 启动.cmd 的**已构建过**分支里，第一次启动的人根本看不到——那正是唯一需要
  // 被告知的一次；macOS / Linux 两个分支都没有。
  // 挪到这里一处解决三个平台、两个分支，时机正好是服务真起来那一刻。
  // 顺带给 Ctrl+C：自己开终端跑的人不会去"关窗口"。
  console.log('要停下来：关掉这个窗口，或者按 Ctrl+C');
  // 自动开浏览器，省掉手敲网址这一步。已经开着的话浏览器只会把那个标签页拉到前面，
  // 不会重复开，所以不用去猜有没有开过。NO_OPEN=1 可以关掉。
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} ${url}`, () => {});      // 开不起来无所谓，网址已经打印出来了
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // 最常见的占用者就是上一次没关掉的同一个应用。那种情况下正确的反应不是换端口，
  // 是告诉你"已经在跑了，直接打开就行"——而不是甩一段 EADDRINUSE 栈追踪。
  void alreadyOurs().then((ours) => {
    console.log(ours
      ? `正音已经在 ${url} 上跑着了，直接打开就行——这次不用再起一遍。`
      // 「在 .env 里加一行」对没见过这个文件的人是半句话：它多半还不存在，
      // 而且他不知道该去哪儿建。旁边就有 .env.example，指过去比让他凭空造一个强。
      : `端口 ${port} 被别的程序占着。\n`
      + `在正音这个文件夹里建一个名叫 .env 的文本文件（旁边的 .env.example 就是样板，`
      + `复制一份改名也行），写一行 PORT=30041，再启动一次。`);
    process.exit(ours ? 0 : 1);
  });
});
