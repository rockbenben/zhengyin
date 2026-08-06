import { Hono } from 'hono';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { analyzeText } from './service.js';
import { matchNotes } from './analysis/match.js';
import { lookupWord, tokenize } from './analysis/lookup.js';
import { attributeTags } from './analysis/features.js';
import { syllabify } from './analysis/syllables.js';
import { phonemeSubs, alignPhonemes, renameTargets, renameHeard, type PhonemeSub, type AlignOp } from './analysis/diff.js';
import { collapseStress, normalizeEspeakIpa, normalizeEspeakPhones, CONFIDENT } from './analysis/espeak.js';
import { guidanceSections } from './analysis/guidance.js';
import { articulationTable, PLACES, MANNERS, VOWEL_ROWS, VOWEL_COLS, vowelCell } from './analysis/articulation.js';
import { confusionContrasts } from './analysis/confusions.js';
import type { NoteStore, Note } from './notes.js';
import type { fetchMwAudio, verifyMwKey } from './audio/mw.js';
import type { recognizePhonemes, checkPhonemeAsr } from './audio/phonemeAsr.js';
import type { synthesizeTts } from './audio/tts.js';
import * as store from './db.js';
import { syncProfile, worthANote, severityOf, notesCovering } from './profile.js';
import { judge } from './judge.js';
import { reanalyzeEntries } from './reanalyze.js';
import { shelfOf, compareShelf, coversOf } from './shelf.js';
import { reconcileAttempts } from './reconcile.js';
import { GRADES, CardNotFoundError, type ReviewStore, type Grade } from './review.js';
import { invalidUserName } from './users.js';
import { maskKey, readEnvFile, readEnvValue, upsertEnvValue, writeEnvFile } from './envfile.js';
import { loadRegistry, modelState, resolveModel } from './models.js';

/**
 * 低于这个信噪比，评测结果照给，但**不写进发音档案和复习队列**。
 *
 * 噪声大时模型输出很不稳：同一个 light，安静时是干净的 /l aɪ t/，吵的时候
 * 连着五次被听成 /m ɛ t/。发音不会在几小时里变成这样，录音条件会。
 * 门槛只在服务端——前端有拷贝就会各走各的（sure 的 0.5 曾经有三份）。
 */
const RECORD_MIN_SNR_DB = 20;

export interface AppDeps {
  db: Database.Database;
  noteStore: NoteStore;
  audioDir: string;
  mwKey: string | undefined;
  fetchMw: typeof fetchMwAudio;
  synthTts: typeof synthesizeTts;
  now: () => string;
  review: ReviewStore;
  today: () => string;
  modelsDir: string;
  /** .env 的路径。设置页保存 MW_API_KEY / VOSK_MODEL 时写这里，重启后仍然生效 */
  envFile: string;
  /** 仓库根，用来定位 scripts/vosk-models.json */
  root: string;
  verifyMw: typeof verifyMwKey;
  /** 本地音素识别边车客户端（asr-service），连不上时返回 reachable:false */
  recognizePhonemes: typeof recognizePhonemes;
  checkPhonemeAsr: typeof checkPhonemeAsr;
  /** 这台机器有没有 uv。没有的话边车永远起不来，界面据此直接给装法而不是让人等 */
  hasUv: boolean;
  /** 发音档案 Markdown 的路径。发音统计会写进它的 AUTO 标记块，手写部分不动 */
  profileFile: string;
  /** 多用户。实现是 users.ts 的 UserManager，index.ts 接线；测试里给 stub */
  users: {
    current: () => string;
    list: () => string[];
    switchTo: (name: string) => 'ok' | 'not-found' | 'invalid';
    create: (name: string) => 'ok' | 'exists' | 'invalid';
  };
}

// 共享谓词：判断某词条是否命中某笔记（笔记 triggers 与词条各词 tags 的并集有交集）。
// /api/notes 的 exampleCount 和 /api/notes/:id 的 examples 都靠它反查，避免两处各写一份同样的逻辑。
function entryHasNote(entry: store.EntryRow, note: Note): boolean {
  const tags = new Set(entry.words.flatMap((w) => w.tags));
  // 两条路都算：讲音的笔记看 trigger，讲词的笔记看词条本身（见 notes.ts 的 Note.words）
  return note.triggers.some((t) => tags.has(t)) || note.words.includes(entry.text);
}

// 类型守卫写成一个具名 type predicate，而不是内联 `typeof x === 'string' && SET.has(x as T)`——
// 后者 TS 不会把 x 的类型窄化成 T，下游还得再 cast 一次；这样写一次，调用点直接拿到窄化后的
// Grade 类型，也顺带把"合法 grade 是什么"这份知识只放这一处。
function isGrade(g: unknown): g is Grade {
  return typeof g === 'string' && GRADES.has(g as Grade);
}

/**
 * 这个词上「跟你有关」的笔记：笔记 id → 是哪几处错把它拉出来的（`i→aɪ` 这样）。
 * 讲这个词本身的（`words:`）也算，那种不需要你先错一次。
 *
 * **抽出来是因为两处在数同一个东西，而数出来不一样。** 词条页摆在外面的是这一档，
 * 而首页那张表的「讲解」列数的是 `matchNotes` 的全部命中——实测 comfortable
 * 列上写着「5 篇」，点进去一篇都没摆出来（五篇全收在折叠里）。列表许了一个
 * 到了目的地不兑现的诺，而笔记越攒越多这个差越大：85 篇时长词命中 26 篇，
 * 那一列就从「有多少讲解可看」变成了「这个词有多长」。
 */
function relevantNotes(deps: AppDeps, text: string, hits: ReturnType<typeof matchNotes>) {
  // **只让替换说话**，理由见下面 entryDetail 里那段注释
  const myErrors = store.errorsOnWord(deps.db, text).filter(
    (e) => e.kind === 'sub' && e.targetIpa !== null,
  );
  const becauseOf = new Map<string, string[]>();
  for (const e of myErrors) {
    for (const n of notesCovering(e, deps.noteStore.all())) {
      const label = `${e.targetIpa}→${e.heardIpa}`;
      const cur = becauseOf.get(n.id) ?? [];
      if (!cur.includes(label)) cur.push(label);
      becauseOf.set(n.id, cur);
    }
  }
  // 讲这个词的笔记：它整篇就是关于这个词的，没有「你还没在这儿错过」这一说
  for (const h of hits) {
    if (h.matched.some((m) => m.startsWith('word:')) && !becauseOf.has(h.note.id)) {
      becauseOf.set(h.note.id, []);
    }
  }
  return becauseOf;
}

function entryDetail(deps: AppDeps, text: string) {
  const entry = store.getEntry(deps.db, text);
  if (!entry) return null;
  const tags = [...new Set(entry.words.flatMap((w) => w.tags))];
  const hits = matchNotes(tags, deps.noteStore.all(), entry.text);
  // 笔记算「已确认的短板」还是「资料」，看**这个使用者自己的记录**，不看 frontmatter
  const ev = store.noteEvidence(deps.db);

  // ── 哪几篇是**跟这个词有关**的 ──
  //
  // 判据**带方向，而且只算这一个词**：这篇笔记教得了一处**你在这个词上**真犯过的错。
  //
  // 原来用的是全局统计（phonemeStats）——只要"你在别处犯过这个错"且"这个词里有那个音"
  // 就算数。实测 click：你在它上面只错过 l→n，页面却同时摆着「长短元音」，
  // 因为你在 **thin** 上错过 ɪ→i，而 click 里有个 /ɪ/。而折叠那行写着
  // 「你还没在**这个词上**错过」，反过来就是在说外面那些你错过了——那句话当时是假的。
  //
  // 换成按词算之后，"这个词里有那个音"这个条件自动成立（错就是在这个词上犯的），
  // 所以 inWord 那道过滤不再需要。
  //
  // **只让替换说话。** 替换点名了一对音（把 A 念成了 B），而这些笔记教的就是那一对；
  // 漏音只说"那个音没出现"，不指向任何一对，contrast 类的笔记教不了它。
  // 实测：dopamine 里 `/n/ 没发出来` 2 次（多半是坏转写），按"漏音也算"的话
  // 会把 l-vs-n 拉到外面——而这个词里根本没有 /l/。
  //
  // 顺手记下**是哪几处错**把它拉到外面来的。界面上那行小字原来一律是
  // 「因为这个词里有 l」——那说的是"怎么匹配上的"，而它摆在外面的真实理由是
  // "你在这儿把 l 念成了 n"。后者才是这一栏存在的意义。
  // 算法在 relevantNotes 里，首页那张表数的是同一个东西。
  const becauseOf = relevantNotes(deps, text, hits);
  const relevant = new Set(becauseOf.keys());
  const audio = store.getAudio(deps.db, text);
  return {
    text: entry.text,
    createdAt: entry.createdAt,
    words: entry.words,
    audio: audio.filter((a) => a.word !== null)
      .map((a) => ({ word: a.word, source: a.source, url: `/api/audio/${a.file}` })),
    phraseAudio: (() => {
      const p = audio.find((a) => a.word === null);
      return p ? { source: p.source, url: `/api/audio/${p.file}` } : null;
    })(),
    // 按"跟你有没有关系"排：你在这个词上真错过的排前面，其余是资料。
    // 词条页的匹配规则（沾上一个音素就算）本身是对的——light 有 /l/ 就该看到 l/n 那篇——
    // 但笔记越攒越多，每个含 /n/ 的词都会挂上 l-vs-n 和 n-vs-ng，列表无限长。
    // 而音素条上点任意一个音本来就能到那个音的页面，那里列着讲它的笔记。
    // 所以这里不再是"音素笔记索引"，只负责把**跟你有关的**排到前面。
    notes: hits.map((h) => ({
      id: h.note.id, title: h.note.title, severity: severityOf(ev.get(h.note.id), h.note),
      // 跟**这个词**有关吗——界面据此决定摆在外面还是收进折叠里。
      // 「讲这个词的也算」那一条在 relevantNotes 里，不在这儿再判一遍
      relevant: relevant.has(h.note.id),
      /** 是哪几处错把它拉到外面来的（`l→n` 这样）。讲词的笔记和折叠里的都是空 */
      becauseOf: becauseOf.get(h.note.id) ?? [],
      matched: h.matched, markdown: h.note.markdown,
    })),
    // 这个词的复习状态。放在词条详情里而不是让前端去查 /api/review/due——
    // 那个接口只给**到期**的卡，收藏了但还没到期的词星标会显示成没收藏。
    review: deps.review.cardOf(entry.text) ?? null,
  };
}

/**
 * 取这个词的「参考基准」：让 MW 真人录音过一遍同一个模型，用它的转写当声学标尺。
 * 按音频文件缓存，同一个文件只算一次。拿不到返回 null，调用方退回词典。
 *
 * 三种拿不到：没有真人录音（**合成音不能当标尺**——cat 的 TTS 被转成 /k eː t/，
 * 比词典还远）、边车这会儿测不了、参考转写跟词典音素数不等长（位置对不上就没法
 * 用词典音标给错误命名；实测 30/30 都等长，走到这一支说明反常）。
 */
export interface BaselineRepair { index: number; from: string; to: string; times: number }

/**
 * 判定"基准在这个位置上是错的"需要多少次证据。
 * 跟「该补的笔记」的 MIN_COUNT 同一个量级：3 次以下谈不上"反复"。
 */
const REPAIR_MIN = 3;

async function referenceBaseline(
  deps: AppDeps, owner: string, target: string, dictIpa: string[], dictNames: string[],
): Promise<{ ipa: string[]; file: string; drift: number[]; repaired: BaselineRepair[] } | null> {
  const dictLength = dictIpa.length;
  // 只认整段 target 对应的那一条真人录音。短语的整句音频服务端只有 TTS，所以短语走词典。
  const row = store.getAudio(deps.db, owner).find((a) => a.source === 'mw' && a.word === target);
  if (!row) return null;

  let raw = store.getReferenceIpa(deps.db, row.file);
  if (raw === null) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(deps.audioDir, row.file)));
    } catch {
      return null;                       // 音频文件不在了：退回词典，不是错误
    }
    const res = await deps.recognizePhonemes(bytes);
    if (res.ipa === null) return null;   // 边车这会儿不行：退回词典
    raw = res.ipa;
    try {
      store.putReferenceIpa(deps.db, row.file, raw, deps.now());
    } catch (e) {
      console.warn('[pronounce] 缓存参考转写失败，本次照常使用', e);
    }
  }

  const ipa = collapseStress(normalizeEspeakIpa(raw));
  // 长度不等就不用它：位置对不上，没法用词典音标给错误命名，硬用会张冠李戴
  if (ipa.length !== dictLength) return null;

  // ── 基准跟词典差在哪几个位置 ──
  //
  // 差异本身不是故障，正是基准在干活（book 的 /ʊ/ 两边都被听成 /æ/，抵消掉）。
  // 算出来是为了驱动下面的**纠正**——因为"模型对真人录音的转写可信"这个前提
  // 并不总成立：dopamine 7 个音里差 3 个，全库最差。
  //
  // ⚠️ **不要据此给界面加警告。** 试过「这把尺子有点歪」（把正常当异常）和
  // 「已按你的录音改回词典值」（修完之后那种情况就不会发生，没有听众），两版都撤了。
  // drift / repaired 只作为诊断数据留在 API 里，不进评测流。
  const drift: number[] = [];
  for (let i = 0; i < ipa.length; i++) if (ipa[i] !== dictIpa[i]) drift.push(i);

  // ── 按你自己的录音纠正基准 ──
  //
  // 基准跟词典不一致的位置上，如果你反复发出词典那个值、且比发出基准值更多次，
  // 多半是基准错了。实测 dopamine 第 5 位：词典 /i/、基准 /eɪ/，15 次里你发出
  // /i/ 十次——念对了却被判错 11 次。
  //
  // 只纠正证据压倒性的（≥REPAIR_MIN 且严格多于基准值）：ɔ×6 对 ʌ×5 那种
  // 是真的分不清，不是基准坏了。
  const repaired: BaselineRepair[] = [];
  if (drift.length > 0) {
    // **按 dictNames 查，不是 dictIpa**：库里存的 target_ipa 是词典原名（ə/ɚ 保留），
    // 而 dictIpa 是重音归并之后的（ə→ʌ）。拿归并后的去查，一条都对不上——
    // 第一版就是这么写的，纠正静默失效，实测才发现。
    //
    // 统计出来的"听到什么"要**折叠之后再比**：判定本身就是在归并空间里做的
    // （align 比的是 collapseStress(heard) 和 baseline），这里不折叠的话，
    // 他发出的 ʌ 跟词典的 ə 会被算成两回事。
    const seen = store.heardByPosition(deps.db, owner, dictNames);
    const folded = seen.map((tally) => {
      const out: Record<string, number> = {};
      for (const [p, n] of Object.entries(tally)) {
        const key = collapseStress([p])[0];
        out[key] = (out[key] ?? 0) + n;
      }
      return out;
    });
    for (const i of drift) {
      const dictHits = folded[i]?.[dictIpa[i]] ?? 0;
      const baseHits = folded[i]?.[ipa[i]] ?? 0;
      if (dictHits >= REPAIR_MIN && dictHits > baseHits) {
        repaired.push({ index: i, from: ipa[i], to: dictIpa[i], times: dictHits });
        ipa[i] = dictIpa[i];
      }
    }
  }

  return { ipa, file: row.file, drift, repaired };
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, mwConfigured: Boolean(deps.mwKey) }));

  // ── 多用户 ──────────────────────────────────────────────
  // 谁在用由服务端定（整机一个「当前用户」），网页和 AI 端读到的永远一致。
  const userInfo = () => ({ current: deps.users.current(), users: deps.users.list() });

  app.get('/api/user', (c) => c.json(userInfo()));

  app.post('/api/user', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    if (typeof body.name !== 'string') return c.json({ error: '缺 name' }, 400);
    // 判据只有一处（users.ts 的 invalidUserName）：直接调它，把真实理由原样回给用户，
    // 而不是在这儿另写一句对不上具体规则的散文
    const bad = invalidUserName(body.name);
    if (bad) return c.json({ error: bad }, 400);
    const r = deps.users.switchTo(body.name);
    if (r === 'invalid') return c.json({ error: '这个名字不能用' }, 400);
    // 不自动新建：手滑打错名字不该凭空多一个用户
    if (r === 'not-found') return c.json({ error: `没有叫「${body.name}」的用户` }, 404);
    return c.json(userInfo());
  });

  app.post('/api/users', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    if (typeof body.name !== 'string') return c.json({ error: '缺 name' }, 400);
    const bad = invalidUserName(body.name);
    if (bad) return c.json({ error: bad }, 400);
    const r = deps.users.create(body.name);
    if (r === 'invalid') return c.json({ error: '这个名字不能用' }, 400);
    if (r === 'exists') return c.json({ error: `已经有「${body.name}」了` }, 400);
    return c.json(userInfo());
  });

  // ---- 设置：Merriam-Webster 词典 API key ----
  // 只回是否已配置 + 末 4 位，绝不回显完整密钥。
  app.get('/api/settings/mw-key', (c) => c.json({
    configured: Boolean(deps.mwKey),
    masked: deps.mwKey ? maskKey(deps.mwKey) : null,
  }));

  // 保存后**立即生效，不用重启**：deps.mwKey 在 /api/health 和录入 handler 里都是请求时
  // 才读的，改这一个字段就够了。同时写进 .env，下次启动照样在。
  app.put('/api/settings/mw-key', async (c) => {
    let body: { key?: unknown; verify?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) return c.json({ error: 'key 不能为空' }, 400);
    // key 要写进 .env 的一行里，带换行会把文件写坏
    if (key.includes('\n') || key.includes('\r')) return c.json({ error: 'key 里不能有换行' }, 400);

    if (body.verify !== false) {
      const result = await deps.verifyMw(key);
      if (!result.ok) return c.json({ error: `这个 key 没通过校验：${result.reason}` }, 400);
    }

    try {
      writeEnvFile(deps.envFile, upsertEnvValue(readEnvFile(deps.envFile), 'MW_API_KEY', key));
    } catch (e) {
      console.warn('[settings] 写 .env 失败', e);
      return c.json({ error: `写入 .env 失败：${(e as Error).message}` }, 500);
    }
    deps.mwKey = key;
    return c.json({ configured: true, masked: maskKey(key) });
  });

  // ---- 设置：本地识别模型（小 39MB / 大 125MB）----
  // 选择存 .env 的 VOSK_MODEL，下载脚本读同一个值，两边不会各选各的。
  app.get('/api/settings/model', (c) => {
    const reg = loadRegistry(deps.root);
    const selected = readEnvValue(readEnvFile(deps.envFile), 'VOSK_MODEL') ?? undefined;
    return c.json(modelState(reg, selected, deps.modelsDir));
  });

  app.put('/api/settings/model', async (c) => {
    let body: { id?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const reg = loadRegistry(deps.root);
    const id = typeof body.id === 'string' ? body.id : '';
    // 必须是清单里真实存在的 id。resolveModel 遇到不认识的会静默退回默认值，
    // 那样用户点了「大模型」却被悄悄换成默认值，界面还显示成功——必须挡在前面。
    if (!reg.models.some((m) => m.id === id)) {
      return c.json({ error: `未知的模型 id：${id}` }, 400);
    }
    try {
      writeEnvFile(deps.envFile, upsertEnvValue(readEnvFile(deps.envFile), 'VOSK_MODEL', id));
    } catch (e) {
      console.warn('[settings] 写 .env 失败', e);
      return c.json({ error: `写入 .env 失败：${(e as Error).message}` }, 500);
    }
    return c.json(modelState(reg, id, deps.modelsDir));
  });

  app.delete('/api/settings/mw-key', (c) => {
    try {
      writeEnvFile(deps.envFile, upsertEnvValue(readEnvFile(deps.envFile), 'MW_API_KEY', null));
    } catch (e) {
      console.warn('[settings] 写 .env 失败', e);
      return c.json({ error: `写入 .env 失败：${(e as Error).message}` }, 500);
    }
    deps.mwKey = undefined;
    return c.json({ configured: false, masked: null });
  });

  app.post('/api/entries', async (c) => {
    let body: { text?: string; ipaOverride?: string };
    try {
      body = await c.req.json<{ text: string; ipaOverride?: string }>();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const { text, ipaOverride } = body;
    if (!text?.trim()) return c.json({ error: '要先输入一个词' }, 400);
    const key = text.trim().toLowerCase();
    // ── 一个字母都没有的，直接不建 ──
    //
    // 不能靠"先建、查不到再删"兜底：`.` 在 URL 路径里是特殊段，
    // DELETE /api/entries/. 会被规范化掉，删不掉——库里就永久多一行，
    // 连它自己的「删除」按钮都点不动。没有字母的东西本来也查不出音标。
    if (!/[a-z]/i.test(key)) {
      return c.json({ error: `「${text.trim()}」里一个英文字母都没有——这里要一个英文单词或短语` }, 400);
    }
    const words = analyzeText(key, ipaOverride);
    if (words.length === 0) return c.json({ error: '没找出可分析的词，换一个说法试试' }, 400);
    store.upsertEntry(deps.db, key, words, deps.now());

    // 音频：逐词 MW（有 key 时）→ 失败 TTS；短语额外整句 TTS。
    // 已入库的 entry 不能因为音频这一步的意外异常（比如 addAudio 遇到非法 source）而丢失，
    // 所以这整段包一层 try/catch：音频拿不到就跳过，不影响响应里已经落库的词条数据。
    try {
      // **要看"已有的是什么来源"，不能只看"有没有"。**
      //
      // 只判有没有的话，一个词落过一次合成音就**永远**不会再去试真人录音——
      // 哪怕后来配好了 MW key。实测有六个词这么卡在 TTS 上，而它们 MW 都有真人录音。
      //
      // 代价不止音质：referenceBaseline() 只认 source==='mw'，这些词的评测会
      // 永久走词典基准，也就是模型元音偏置最伤的那条退路。
      const have = new Map<string, { id: number; source: string; file: string }>();
      for (const a of store.getAudio(deps.db, key)) {
        have.set(a.word ?? '', { id: a.id, source: a.source, file: a.file });
      }
      for (const w of words) {
        const cur = have.get(w.word);
        // 已经是真人录音：不动它，也不白跑一趟 MW
        if (cur?.source === 'mw') continue;

        let file: string | null = null;
        let source: 'mw' | 'tts' = 'mw';
        if (deps.mwKey) file = await deps.fetchMw(w.word, deps.mwKey, deps.audioDir);

        if (cur) {
          // 升级路径。MW 这次也没拿到就保持现状——绝不能删了旧的却没有新的，
          // 那会把一个能听的合成音变成 404。这一条同时覆盖了"根本没有 key"的情况：
          // 没 key 时 fetchMw 压根不会被调用，file 必然是 null，走的就是这里。
          // （原来在上面另写了一个 `if (cur && !deps.mwKey) continue`，行为完全等价、
          //  变异测试杀不掉它——冗余守卫又测不到，删掉比留着假装它在干活好。）
          if (!file) continue;
          store.removeAudioRow(deps.db, cur.id);
          store.addAudio(deps.db, { entryText: key, word: w.word, source: 'mw', file });
          // 旧文件只在没人再引用时才删（"black cat" 和 "black" 会共用 black-tts.mp3）
          if (cur.file !== file && !store.audioFileInUse(deps.db, cur.file)) {
            const f = join(deps.audioDir, cur.file);
            if (existsSync(f)) unlinkSync(f);
          }
          have.set(w.word, { id: -1, source: 'mw', file });
          continue;
        }

        if (!file) { file = await deps.synthTts(w.word, deps.audioDir); source = 'tts'; }
        if (file) store.addAudio(deps.db, { entryText: key, word: w.word, source, file });
        // 短语里同一个词可能出现多次（"so so"）：have 是循环开始前算好的快照，循环
        // 内部必须自己再标记一次，否则同一个词会在这一次 POST 里被重复 fetchMw/synthTts、
        // 重复插入 audio 行——多出来的重复行还会在前端变成重复的 React key。
        have.set(w.word, { id: -1, source, file: file ?? '' });
      }
      const existing = new Set(have.keys());
      if (words.length > 1 && !existing.has('')) {
        const file = await deps.synthTts(key, deps.audioDir);
        if (file) store.addAudio(deps.db, { entryText: key, word: null, source: 'tts', file });
      }
    } catch (e) {
      console.warn('[entries] 音频抓取失败，词条已保存', e);
    }
    // **刻意不在这里加复习卡。**「查过这个词」和「要练这个词」是两回事：
    // 前者是日志，只增不减、多了无害；后者是工作集，一旦堆到几十张人就再也不会点开。
    // 复习卡只在有证据时才产生——录音真发错了（见 /api/pronounce），或者你自己标了星。
    return c.json(entryDetail(deps, key));
  });

  app.get('/api/entries', (c) => {
    const entries = store.listEntries(deps.db).map((e) => {
      const tags = [...new Set(e.words.flatMap((w) => w.tags))];
      const audio = store.getAudio(deps.db, e.text);
      return {
        text: e.text,
        ipa: e.words.map((w) => w.ipa).filter(Boolean).join(' '),
        updatedAt: e.updatedAt,
        // **数的是「点进去真会摆出来的那几篇」，不是全部命中。**
        // 全部命中会随笔记总数一起涨（实测 85 篇时长词命中 26 篇），于是这一列
        // 慢慢变成「这个词有多长」——international 24 篇、light 10 篇，
        // 排序出来跟音素个数一个样，对「该点哪个词」不再有分辨力。
        // 更要紧的是它现在就跟词条页对不上：comfortable 这里写 5 篇，点进去 0 篇。
        noteCount: relevantNotes(deps, e.text, matchNotes(tags, deps.noteStore.all(), e.text)).size,
        audioSource: audio.some((a) => a.source === 'mw') ? 'mw' : audio.length > 0 ? 'tts' : null,
      };
    });
    return c.json({ entries });
  });

  app.get('/api/entries/:text', (c) => {
    const d = entryDetail(deps, c.req.param('text').toLowerCase());
    return d ? c.json(d) : c.json({ error: '没有这个词' }, 404);
  });

  app.delete('/api/entries/:text', (c) => {
    const key = c.req.param('text').toLowerCase();
    const removed = store.deleteEntry(deps.db, key);
    for (const a of removed) {
      // 文件名来自 slugify(word)，"black cat" 和 "black" 都可能落到同一个 black-tts.mp3。
      // deleteEntry 已经把这个 entry 自己的 audio 行删掉了，这里再查一遍剩下的 audio 表：
      // 如果还有别的 entry 引用同一个文件名，就不能 unlink，否则那个 entry 的音频会永久
      // 404（重新 POST 它也不会修复，因为 POST 的"已有音频"判断只看 DB 行在不在）。
      if (store.audioFileInUse(deps.db, a.file)) continue;
      const f = join(deps.audioDir, a.file);
      if (existsSync(f)) unlinkSync(f);
    }
    deps.review.removeCard(key);
    return c.json({ ok: true });
  });

  app.get('/api/notes', (c) => {
    const groups: Record<Note['severity'], unknown[]> = { confirmed: [], watch: [], info: [] };
    const entries = store.listEntries(deps.db);
    const ev = store.noteEvidence(deps.db);
    // 先按素材库的顺序排好再分组，前端只要"遇到新的 shelf/place 就起一段"，
    // 不用在客户端复制一份分类学（判据只能有一处）。
    const sorted = deps.noteStore.all()
      .map((n) => ({ n, ...shelfOf(n) }))
      .sort((a, b) => compareShelf({ ...a, title: a.n.title }, { ...b, title: b.n.title }));
    sorted.forEach(({ n, shelf, place, placeLabel }, order) => {
      const exampleCount = entries.filter((e) => entryHasNote(e, n)).length;
      // 分组按**你的**证据来：全新装上的人全在「资料」那一组，一条都不冒充成他的短板
      const sev = severityOf(ev.get(n.id), n);
      groups[sev].push({
        id: n.id, title: n.title, severity: sev, triggers: n.triggers, exampleCount,
        // 素材库把 watch 和 info 两组拼起来看，一拼就把上面排好的顺序打乱了。
        // 给个序号让前端排回来——它不用因此知道书架是怎么分的。
        order,
        // 这篇管的是什么，用来在素材库左边当路标：音素笔记给 IPA，其余给标签/词本身。
        // 用户认的是 /θ/，不是「齿间擦音」四个字。
        covers: coversOf(n),
        shelf, place, placeLabel,
      });
    });
    return c.json({ groups });
  });

  app.get('/api/notes/:id', (c) => {
    const n = deps.noteStore.get(c.req.param('id'));
    if (!n) return c.json({ error: '笔记不存在' }, 404);
    const examples = store.listEntries(deps.db).filter((e) => entryHasNote(e, n)).map((e) => e.text);
    return c.json({ id: n.id, title: n.title, severity: severityOf(store.noteEvidence(deps.db).get(n.id), n), triggers: n.triggers, markdown: n.markdown, examples });
  });

  // upcoming 一起给：没有它，前端分不出「队列空」和「队列有、今天没到期」，
  // 只能对着刚加了四个词的人说「去首页录一次音」。
  app.get('/api/review/due', (c) => {
    const today = deps.today();
    return c.json({ cards: deps.review.due(today), upcoming: deps.review.upcoming(today) });
  });

  // 手动收藏：模型没测出来、但你自己知道虚的词，标个星强制进队列。
  // 收藏的卡片不会自动毕业——那是你要留的，工具不该替你决定。
  app.put('/api/review/:text/star', (c) => {
    const text = c.req.param('text').toLowerCase();
    if (!store.getEntry(deps.db, text)) return c.json({ error: '没有这个词' }, 404);
    // 不在队列里就先建一张（直接建成收藏的），已经在就只补上星标、不重置进度
    deps.review.addCard(text, deps.today(), true);
    return c.json({ starred: true, card: deps.review.cardOf(text) ?? null });
  });

  app.delete('/api/review/:text/star', (c) => {
    const text = c.req.param('text').toLowerCase();
    const card = deps.review.cardOf(text);
    if (!card) return c.json({ starred: false, card: null });
    // 取消收藏之后，如果这个词从来没被判错过，它留在队列里就没有任何理由了——直接出列。
    // 反过来，错过的词取消收藏只是回到"证据驱动"，仍然留在队列里按阶梯走。
    const stat = store.wordStat(deps.db, text);
    const everWrong = stat.attempts > stat.clean;
    if (!everWrong) {
      deps.review.removeCard(text);
      return c.json({ starred: false, card: null });
    }
    return c.json({ starred: false, card: deps.review.setStarred(text, false) });
  });

  app.post('/api/review/:text', async (c) => {
    let body: { grade?: unknown };
    try {
      body = await c.req.json<{ grade?: unknown }>();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const { grade } = body;
    // grade 直接驱动复习进度重置/推进（见 review.ts 的 nextState）——除 notes/ 外唯一
    // 不可再生的数据，绝不能信任客户端传来的任意字符串。必须严格是这三个字面量之一。
    if (!isGrade(grade)) {
      return c.json({ error: `grade 必须是 ${[...GRADES].join('/')} 之一` }, 400);
    }
    try {
      const next = deps.review.grade(c.req.param('text').toLowerCase(), grade, deps.today());
      // next 为 null = 已经爬到顶级又答对，毕业出列了。前端据此显示"这个词你会了"，
      // 而不是当成一次普通的推进。
      return c.json({ card: next, graduated: next === null });
    } catch (e) {
      // 区分"这张卡片压根不存在"（404，正常业务情况）和其它失败（比如 save() 写盘
      // 出错，得回 500）——以前不管哪种失败都被这个 catch 一律吞成 404 "无此卡片"。
      if (e instanceof CardNotFoundError) return c.json({ error: '无此卡片' }, 404);
      console.warn('[review] 评分失败', e);
      return c.json({ error: '评分失败' }, 500);
    }
  });

  app.post('/api/asr', async (c) => {
    let body: { target?: string; heard?: string };
    try {
      body = await c.req.json<{ target?: string; heard?: string }>();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const { target, heard } = body;
    if (!target?.trim() || !heard?.trim()) return c.json({ error: '缺 target 或 heard' }, 400);

    const match = heard.trim().toLowerCase() === target.trim().toLowerCase();

    // 逐词按位置对齐后再逐对做音素 diff：两侧词数不等时，只 diff 能对齐上的那些词对
    // （取较短一侧的长度），多出来的词直接丢弃，不臆造对齐关系。任一侧的词不在
    // CMUdict 里就跳过那一对，绝不因未知词让整个接口 500。
    const targetWords = tokenize(target);
    const heardWords = tokenize(heard);
    const pairCount = Math.min(targetWords.length, heardWords.length);

    const subs: PhonemeSub[] = [];
    for (let i = 0; i < pairCount; i++) {
      const t = lookupWord(targetWords[i]);
      const h = lookupWord(heardWords[i]);
      if (!t || !h) continue;
      subs.push(...phonemeSubs(t, h));
    }

    const subTags = subs.flatMap((s) => [`phoneme:${s.targetIpa}`, `phoneme:${s.heardIpa}`]);
    const notes = matchNotes(subTags, deps.noteStore.all())
      .map((x) => ({ id: x.note.id, title: x.note.title, severity: severityOf(store.noteEvidence(deps.db).get(x.note.id), x.note) }));

    return c.json({ match, subs, notes });
  });

  // 给浏览器端 ASR（web/src/lib/asr.ts）建识别语法用：target 的哪些真实词容易被
  // 混淆、且**混淆发生在第几个音素上**，完全由笔记里声明的 phoneme:<ipa> trigger 推出
  // 来（见 analysis/confusions.ts），不是拼写层面的猜测——客户端不该，也不再自己重新
  // 实现一份音系规则（Task 15 定下的原则）。位置信息是音素级评测的依据，见 Contrast。
  app.get('/api/confusions/:word', (c) => {
    const word = c.req.param('word').toLowerCase();
    return c.json({ contrasts: confusionContrasts(word, deps.noteStore.all()) });
  });

  // 音素级评测：录音直接送本地边车，拿不受词表约束的 IPA 串回来，跟 CMUdict 的目标
  // 音素对齐。跟 /api/asr 的根本区别是**它说得出你实际发了什么音**——vosk 那条路只能
  // 在给定的几个词里挑一个。
  //
  // 录音只在本机两个进程之间走（浏览器 → 30031 → 127.0.0.1:30032），不落盘、不出这台机器。
  // 页面据此决定提示什么：边车在的话，vosk 模型装没装根本不重要，不该弹"模型未安装"。
  // uv 装没装是**启动时就知道**的事实（deps.hasUv），跟边车这一刻起没起来是两件事：
  //   ok=false, uv=true  → 真的在加载模型，等着就好
  //   ok=false, uv=false → 永远不会起来，别让人干等，直接给装法
  app.get('/api/pronounce/health', async (c) => c.json({
    ok: await deps.checkPhonemeAsr(), uv: deps.hasUv,
  }));

  app.post('/api/pronounce', async (c) => {
    const target = (c.req.query('target') ?? '').trim().toLowerCase();
    if (!target) return c.json({ error: '缺 target' }, 400);
    // 这次录音属于哪个词条。短语页是逐词录的（"dark night" 里单独录 dark），
    // 而 dark 本身不是词条——把流水和复习卡记在裸词上的话：
    //   · 统计页的例词链接指向一个 404 的词条页
    //   · 复习队列里多出一张永远打不开的卡，每天出现、每天被跳过，还删不掉
    // 所以由前端把所属词条一并传过来；没传就退回 target。
    const owner = (c.req.query('entry') ?? target).trim().toLowerCase();

    // 这次录音的信噪比，由前端量好传过来（它手里才有波形）。没传就是 NaN——
    // 那种情况一律照记，宁可多记也不要因为前端是旧版就静悄悄地丢掉数据。
    const snrDb = Number(c.req.query('snr'));

    // 短语（"black cat"、"dopamine detox"）按词拆开分别查，再把音素首尾相接当成一整串
    // 对齐——模型对短语本来就是连着吐的（spike 实测 black cat → `b l æ k k æ t`），
    // 逐词切开对齐反而要先猜词边界在哪，而那个信息模型没给。
    const words = tokenize(target);
    const looked = words.map((w) => ({ word: w, phones: lookupWord(w) }));
    const missing = looked.filter((x) => !x.phones).map((x) => x.word);
    if (looked.length === 0 || missing.length > 0) {
      return c.json({ error: `CMUdict 里没有「${missing.join('、') || target}」，没法逐音素比对` }, 400);
    }
    const phones = looked.flatMap((x) => x.phones!);

    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length === 0) return c.json({ error: '没收到音频' }, 400);

    const asr = await deps.recognizePhonemes(audio);
    if (asr.ipa === null) {
      return c.json({ error: asr.reason ?? '音素识别失败', reachable: asr.reachable }, 503);
    }

    // 边车给了逐音素置信度就用带置信度的那条路；没给（旧版边车）就退化成纯 IPA，
    // 结果一样能用，只是没法区分"确凿的错"和"模型拿不准"。
    const confPhones = asr.phones ? normalizeEspeakPhones(asr.phones) : null;
    const heard = confPhones ? confPhones.map((p) => p.ipa) : normalizeEspeakIpa(asr.ipa);

    // ── 一个音都没识别出来 = 这次**没录到声音**，不是"每个音都发错了" ──
    //
    // 麦克风没拾到、说得太轻、或者剪辑把整段都当成了静音，都会走到这里。照常往下对齐的话，
    // 目标音会被逐个记成"没发出来"，然后进统计、进发音档案的「该补的笔记」、还生成复习卡。
    //
    // 这不是假设，是查出来的：库里 4 次空识别造出了 15 条"没发出来"，而「该补的笔记」里
    // 排在最前面的 /ɡ/ /æ/ /s/ /l/ 四项**全部**出自它们——工具在催人补一节它自己幻想出来的课。
    // 凭空造出一个不存在的发音问题，是这个工具最坏的一种错。
    if (heard.length === 0) {
      return c.json({ error: '这次没录到可辨的声音，重录一遍（离麦克风近一点、说响一点）' }, 422);
    }

    // 两侧都做重音归并：模型不输出重音，ə/ʌ 和 ɚ/ɝ 这两组纯由重音区分的对立它给不出
    // 判据，硬比会把念对的 water 报成两处错（实测踩过）。
    // dictNames 是词典原名（ə/ɚ 保留）——归并只该影响「判不判错」，不该影响「错叫什么」。
    const dictNames = phones.map((p) => p.ipa);
    const dictIpa = collapseStress(dictNames);

    // ── 比对基准：优先用【参考录音的模型转写】，退而用词典 ──
    //
    // 为什么不直接跟词典比：词典给的是人的音系抽象，模型给的是它对声学信号的转写，
    // 两者天然不一致。实测 30 个真人录音，模型对 book 转出 /b æ k/（词典 /b ʊ k/）、
    // 对 cup 转出 /k æ p/、对 dopamine 三个元音全不一致——那不是发音错，是模型在元音上的
    // 系统性偏置（元音置信度中位数 0.70，35% 低于门槛；辅音中位数 0.94，只有 6% 低于门槛）。
    // 用一个全局门槛去掩盖它，等于把三分之一的元音判断整块扔掉——这个工具就只在评测辅音了。
    //
    // 让参考录音也过同一个模型，偏置两边抵消。附带好处：词典错条自动失效。
    const baseline = await referenceBaseline(deps, owner, target, dictIpa, dictNames);

    const { align, wrong, tags, noteIds } = judge({
      phones,
      heard,
      confs: confPhones?.map((p) => p.conf) ?? null,
      baselineIpa: baseline?.ipa ?? null,
      notes: deps.noteStore.all(),
      target,
    });

    // 笔记不只给个链接，把里面"该怎么动舌头"的那几节直接带上——报了错却不说怎么改，
    // 等于只骂不教。知识仍然只有 notes/ 一处来源，这里只做筛选。
    //
    // **挂哪几篇是 judge 说了算**（judge.ts 的 explainersFor，全应用唯一的判据）。
    // 这里过 matchNotes 只为拿它的排序：按词命中的排最前，那是这个词自己的坑。
    // 每一篇 noteIds 里的笔记必然也在 matchNotes 的结果里——音素那一路的
    // `phoneme:<must>` 一定在 tags 里，按词那一路 target 一样。
    const hits = matchNotes(tags, deps.noteStore.all(), target)
      .filter((h) => noteIds.has(h.note.id));
    const noteEv = store.noteEvidence(deps.db);
    const notes = hits
      .map((x) => ({
        id: x.note.id, title: x.note.title, severity: severityOf(noteEv.get(x.note.id), x.note),
        guidance: guidanceSections(x.note),
      }));

    // 落盘：这个仓库的核心是积累习惯性短板（见 CLAUDE.md），不存下来的话每次结论
    // 看完就蒸发。写失败绝不能连累这次评测的结果——用户已经录完了，结果照给。
    // 背景太吵时**结果照给、但不落盘**：你需要这次的反馈（哪怕它不准），
    // 而发音档案不需要一批录音条件已经坏掉的数据——那些数据会变成"你的习惯性短板"，
    // 而它记的其实是当时房间里的噪声。
    const tooNoisy = Number.isFinite(snrDb) && snrDb < RECORD_MIN_SNR_DB;
    const notRecordedReason = tooNoisy
      ? `背景噪音偏大（信噪比 ${Math.round(snrDb)}dB），这次不计入统计和复习队列`
      : null;

    if (!tooNoisy) {
      try {
        // 真发错了才进复习队列。这是「有证据」的那条入口：
        // 你念错过这个词，所以它值得再练；只是查过一眼的词不进来。
        // 只给**真实存在的词条**建卡——建在裸词上的卡片永远打不开，只会堵在队列里。
        if (wrong.length > 0 && store.getEntry(deps.db, owner)) {
          deps.review.addCard(owner, deps.today());
        }
        const attemptId = store.logAttempt(deps.db, {
          entryText: owner,
          // **不是 owner**：短语词条可以只录其中一个词，而按词声明范围的笔记按它匹配。
          // 少了它，这次的归属日后就重算不出来，只能猜整条。
          target,
          at: deps.now(),
          targetIpa: dictNames, heardIpa: heard,
          // 进统计的只有确凿的错：低置信度的误报一旦沉淀进发音档案，会变成"该补的笔记"里
          // 一堆根本不存在的问题，比不统计更糟。
          ops: align.filter((op) => op.kind === 'match' || wrong.includes(op)),
          // **clean 单独算，不能从 ops 反推**：ops 里没有低置信度的错，
          // 反推出来"模型听到了别的音但没把握"也算全对。见 logAttempt 上的注释。
          // 拿不准的**多余音**不算数——那几乎只能是杂音（气流、碰麦克风），
          // 跟"这个音是什么"的不确定不是一回事。
          clean: align.every((op) => op.kind === 'match' || (op.kind === 'ins' && !op.sure)),
        });
        // 归属单独写。它是**派生**的（错误行 + target + notes/ 就能重算，见 reconcile.ts），
        // 所以不跟流水混在一条 INSERT 里——流水是事实，归属是当前理解。
        store.putAttribution(deps.db, attemptId, noteIds);
        syncProfile(deps.profileFile, deps.db, deps.noteStore, deps.now());
      } catch (e) {
        console.warn('[pronounce] 评测记录写入失败', e);
      }
    }

    return c.json({
      target,
      targetIpa: dictNames,
      // 逐词的音素，前端据此把长长一条音素带按词分段显示（单词时就是一段）
      words: looked.map((x) => ({ word: x.word, ipa: x.phones!.map((p) => p.ipa) })),
      heardIpa: heard,
      rawIpa: asr.ipa,
      align,
      // 这次是跟什么比的。界面要说出来——"跟真人录音比"和"跟词典比"的可信度不一样
      comparedWith: baseline ? 'reference' : 'dictionary',
      referenceIpa: baseline?.ipa ?? null,
      // 基准的**校准细节**，只作为诊断数据下发（curl 得到），**界面刻意不渲染**。
      // drift = 基准跟词典不一致的位置（差异本身正常，那正是基准在干活）
      // repaired = 其中被他自己的录音纠正过来的那些
      // 两条都做过界面提示，都被使用者否掉了；缘由写在 referenceBaseline 上面那段。
      // web/src/components/Recorder.test.tsx 的「基准的校准细节不进评测流」钉着这件事。
      baselineDrift: baseline?.drift ?? [],
      baselineRepaired: baseline?.repaired ?? [],
      // 这次有没有沉淀进发音档案。**界面必须说出来**——静悄悄地不计入，
      // 比计入更糟：你会以为练过的都算数，而档案里根本没有这一次。
      recorded: !tooNoisy,
      notRecordedReason,
      notes,
    });
  });

  // 发音统计。前端的统计页读它；AI 也能直接 curl 它来看你最近在错什么。
  // ── 搬家：导出 / 导入 ──
  //
  // 只带**不可再生**的：查过哪些词、每次录音的判定、复习排到第几档。
  // 音频和参考转写重查一次词典就有，塞进来会让文件从几十 KB 变成几十 MB；
  // notes/ 跟着 git 走。复习进度单独放在 review-state.json，也一并带上。
  app.get('/api/backup', (c) => {
    const data = store.exportBackup(deps.db, deps.now());
    return c.json({ ...data, review: deps.review.snapshot() });
  });

  app.post('/api/backup', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '这不是一个合法的备份文件（读不出 JSON）' }, 400);
    }
    const b = body as Partial<store.Backup> & { review?: unknown };
    // 版本号对不上就直接拒绝。**不猜**：装作能读一个不认识的格式，
    // 结果是往库里灌半截数据，比报错难查得多。
    if (b?.version !== 1 || !Array.isArray(b.entries) || !Array.isArray(b.attempts)) {
      return c.json({ error: '备份文件的格式不对，或者来自更新的版本' }, 400);
    }
    // 每条录音必须带齐重算归属要用的东西：念的是哪个词、每处错落在第几个音上。
    // 缺了不能顺手补一个默认值——`target` 补成整条会让讲那个词的笔记全部落空
    // （实测猜错过一次，96 条里 73 条），`atIndex` 补成 0 会把结构标签安到第一个音上。
    // 这两种都是**看着成功的失败**，不如在门口拒掉。
    if (!b.attempts.every((a) => typeof a?.target === 'string' && a.target !== ''
      && Array.isArray(a.errors) && a.errors.every((e) => Number.isInteger(e?.atIndex)))) {
      return c.json({ error: '备份文件里的录音记录不完整（缺少这次念的词或错误位置），没法导入' }, 400);
    }
    const r = store.importBackup(deps.db, b as store.Backup);
    // 备份里的词条带着**对面那台机器**算出来的推导结果（音素、音节、标签）。
    // 两边版本不一样时导进来的就是按对面的规则算的，而本机的重算只在启动时跑一次——
    // 导入发生在那之后，于是这些词条会一直带着外来的旧标签直到下次重启。
    // 判据跟启动时同一个（reanalyze.ts）：只碰"每个词都在词典里"的，手工音标不动。
    reanalyzeEntries(deps.db);
    // 笔记归属备份里根本没带（它是派生的），导进来的录音这会儿一条归属都没有。
    // 按本机的 notes/ 算一遍——同样是启动时用的那个判据。
    reconcileAttempts(deps.db, deps.noteStore.all());
    let cards = 0;
    if (b.review && typeof b.review === 'object') cards = deps.review.merge(b.review);
    syncProfile(deps.profileFile, deps.db, deps.noteStore, deps.now());
    return c.json({ ...r, cards });
  });

  app.get('/api/stats', (c) => c.json({
    overall: store.overallStats(deps.db),
    // ── 卡住的词：练了很多次、全对率还是很低 ──
    //
    // 这份数据早就算了，但**只喂给发音档案那个 md 文件**——只用网页的人一直看不到。
    // 而对他来说这恰恰是最可操作的一条：音素级的统计说"你 /n/ 错了 21 次"，
    // 它说的是"dopamine detox 你练了 54 次还是过不去"，直接回答"我今天该练什么"。
    // 判据跟档案里那一节共用 stuckWords，不在这儿另立一套。
    stuck: store.stuckWords(deps.db),
    phonemes: store.phonemeStats(deps.db).map((s) => {
      // 「哪些笔记真的教得了这条错误」只有一处判据（profile.ts 的 notesCovering）。
      // 这里一度是另一份拷贝——只要沾上一个音素就算覆盖——于是 /n/→/ŋ/ 在统计页上
      // 被 l-vs-n 认领，而那篇一个字都没提后鼻音。
      const notes = notesCovering(s, deps.noteStore.all());
      // 「这条错误值不值得为它写一篇笔记」**只有一处判据**（profile.ts 的 worthANote）。
      // 之前统计页自己用 `notes.length === 0` 另判了一遍，于是同一句「这些音反复出错」
      // 在发音档案里是 2 条、在统计页上是 14 条——同一个问题两个答案。
      // 门槛留在前端会长出拷贝，sure 的 0.5 就是这么长出三份的。
      return {
        ...s,
        notes: notes.map((n) => ({ id: n.id, title: n.title })),
        worthANote: notes.length === 0 && worthANote(s),
      };
    }),
  }));

  // 发音部位表。前端的「发音部位尺」和「元音四边形」拿它画坐标——只画，不做任何音系推导
  // （客户端不该自己实现一份音系规则）。整张表只有几十条，一次取回、客户端缓存即可。
  app.get('/api/articulation', (c) => c.json({
    places: PLACES, manners: MANNERS, phones: articulationTable(),
  }));

  // ── 音素文档 ──
  //
  // 分工（articulation.ts 顶上也写着）：**这里是音素本身怎么发，跟谁在念无关**；
  // notes/ 是这个人的问题，带自检法和对比训练。混类的后果很直接：
  // 点音素 aɪ 跳过去，看到的是"dopamine 的词尾 /miːn/"，跟这个音毫无关系。
  //
  // 所以音素有自己的落点：怎么发、部位方式、**库里含这个音的例词**，以及真正讲这个音的
  // 笔记（只认 triggers，不认 words —— 讲词的笔记不该因为那个词含这个音就冒出来）。
  app.get('/api/phonemes', (c) => {
    const entries = store.listEntries(deps.db);
    const notes = deps.noteStore.all();
    return c.json({
      places: PLACES,
      manners: MANNERS,
      // 元音那张格子的行列。跟 places/manners 一样由服务端定，界面只摆
      vowelRows: VOWEL_ROWS,
      vowelCols: VOWEL_COLS,
      phones: articulationTable().map((p) => {
        const tag = `phoneme:${p.ipa}`;
        return {
          ...p,
          // 元音落在哪一格（双元音按起点）。辅音有 place/manner，这是元音的对应物
          ...(p.kind === 'vowel' ? vowelCell(p) : {}),
          exampleCount: entries.filter((e) => e.words.some((w) => w.tags.includes(tag))).length,
          noteCount: notes.filter((n) => n.triggers.includes(tag)).length,
        };
      }),
    });
  });

  app.get('/api/phonemes/:ipa', (c) => {
    // IPA 符号在 URL 里是编码过的（ə → %C3%99…）。Hono 的 param 已经解过一层，
    // 这里不再 decode，否则含 % 的输入会二次解码报错。
    const ipa = c.req.param('ipa');
    const phone = articulationTable().find((p) => p.ipa === ipa);
    // 404 而不是空壳：URL 里敲错一个符号时，"没有这个音素"比一个空页面好查
    if (!phone) return c.json({ error: `没有这个音素：${ipa}` }, 404);
    const tag = `phoneme:${ipa}`;
    return c.json({
      phone, places: PLACES, manners: MANNERS,
      examples: store.listEntries(deps.db)
        .filter((e) => e.words.some((w) => w.tags.includes(tag)))
        .map((e) => ({ text: e.text, ipa: e.words.map((w) => w.ipa).filter(Boolean).join(' ') })),
      // 只看 triggers。讲词的笔记（words）不进来——那正是要分开的东西。
      notes: (() => {
        const ev = store.noteEvidence(deps.db);
        return deps.noteStore.all()
          .filter((n) => n.triggers.includes(tag))
          .map((n) => ({ id: n.id, title: n.title, severity: severityOf(ev.get(n.id), n) }));
      })(),
    });
  });

  app.get('/api/audio/:file', serveStaticAudio(deps));

  app.get('/api/model/:file', (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9.-]+\.tar\.gz$/.test(file)) return c.json({ error: 'bad file' }, 400);
    const path = join(deps.modelsDir, file);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    return c.body(readFileSync(path), 200, { 'Content-Type': 'application/gzip' });
  });

  return app;
}

function serveStaticAudio(deps: AppDeps) {
  return (c: any) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9-]+\.mp3$/.test(file)) return c.json({ error: 'bad file' }, 400);
    const path = join(deps.audioDir, file);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    return c.body(readFileSync(path), 200, { 'Content-Type': 'audio/mpeg' });
  };
}
