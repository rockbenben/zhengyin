import Database from 'better-sqlite3';

/**
 * 一个词的分析结果，整个以 JSON 存进 `entries.words_json`。
 *
 * **全部字段都是必填的。** 曾经有四个是可选的，因为库里躺着那几个字段出现之前落库的
 * 旧词条；发布前把开发机上的库清空了，而任何一台新机器上的词条都由下面这一版
 * `analyzeText()` 写入，一次都不会缺。**别再往这里加可选字段来兼容老数据**——
 * 那条路已经关了，加列/改结构就得写迁移（见 CLAUDE.md）。
 */
export interface WordAnalysis {
  word: string; found: boolean;
  arpabet: string[]; ipa: string; tags: string[];
  /** 逐音素归属：跟 arpabet 同下标一一对应。phoneIpa[i] 是 arpabet[i] 的 IPA 符号 */
  phoneIpa: string[];
  /** phoneTags[i] 是这个音素位置贡献的 tag（attributeTags() 算的，前端不重算音系规则） */
  phoneTags: string[][];
  /**
   * 逐音节的音素下标分组，如 dopamine → [[0,1],[2,3],[4,5,6]]。
   * 音节边界本来就在 syllabify() 里算出来了，早先只留了个音节数就丢掉——
   * 结果页头的 /ˈdoʊpəˌmin/ 跟下面那排音素格对不上，人得自己在心里切。
   */
  syllables: number[][];
  /**
   * 逐音节的重音级别：1 主重音、2 次重音、0 轻读。跟 syllables 同下标。
   *
   * **必须是逐音节的三档，不能压成"主重音在第几节"一个下标**：那样"其余都是轻读"
   * 就成了默认结论，而 dopamine 是 1-0-2，词尾 -mine 是**次重音**、元音是满的 /miːn/。
   */
  syllableStress: number[];
}
export interface EntryRow { text: string; words: WordAnalysis[]; createdAt: string; updatedAt: string }
export interface AudioRow { id: number; entryText: string; word: string | null; source: 'mw' | 'tts'; file: string }

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      text TEXT PRIMARY KEY, words_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_text TEXT NOT NULL, word TEXT,
      source TEXT NOT NULL CHECK (source IN ('mw','tts')),
      file TEXT NOT NULL
    );
    -- 每一次音素级评测的流水。这个仓库的核心目的是"积累使用者的发音习惯短板"
    -- （见 CLAUDE.md），而在这张表之前，每次评测的结论看完就蒸发了——工具自己测出来的
    -- 数据一条都没沉淀下来，发音档案全靠手写。
    CREATE TABLE IF NOT EXISTS attempt (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_text TEXT NOT NULL,   -- 词条（短语时是整条）
      -- 这一次**实际念的**是哪个词。短语词条可以只录其中一个词，那时它跟 entry_text
      -- 不是一回事，而按词声明范围的笔记（words:）正是按它匹配的。
      -- 少了这一列，"这次该挂哪几篇笔记"就无法重算——只能猜整条。
      target TEXT NOT NULL,
      at TEXT NOT NULL,
      target_ipa TEXT NOT NULL,   -- 空格分隔
      heard_ipa TEXT NOT NULL,
      clean INTEGER NOT NULL      -- 每个音都对上 = 1
    );
    -- 一次评测里的每一处错。拆成独立的表是为了能直接按音素聚合排行，
    -- 不用把每行的 JSON 都解出来再在内存里数。
    CREATE TABLE IF NOT EXISTS attempt_error (
      attempt_id INTEGER NOT NULL REFERENCES attempt(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('sub','del','ins')),
      target_ipa TEXT,            -- sub/del 有；ins 为 null
      heard_ipa TEXT,             -- sub/ins 有；del 为 null
      -- 这处错落在词典音素序列的第几个上。sub/del 就是那个音的下标；
      -- ins 没有自己的位置，存的是它夹进去的**位置**（前一个是 at_index-1）。
      -- 结构类标签（cluster-onset/coda、clear-l、dark-l、flap-t、final-voiced）
      -- 是按位置算的，少了这一列就只能从音素瞎猜。
      at_index INTEGER NOT NULL
    );
    -- 参考录音的模型转写，按音频文件缓存。
    -- 存的是【边车的原始输出】而不是归一化后的结果：归一化表（analysis/espeak.ts）
    -- 以后还会改，存原始的话改完立刻生效，不用把缓存全作废重跑。
    -- 这次评测该挂哪几篇笔记。
    --
    -- 它回答一个**只有你的数据能回答**的问题：这篇笔记讲的毛病，是不是你身上真有的？
    -- 笔记的 frontmatter 回答不了——那是写笔记的人对读者的断言，而这个应用是给
    -- 每个人用的。全新装上的人不该看到一堆写着「已确认的短板」的东西。
    --
    -- ⚠️ **这是一张缓存，不是流水。** 内容完全由 (attempt_error + target + notes/)
    -- 派生（judge.ts 的 explainersFor），每次启动和每次导入都会重算一遍
    -- （reconcile.ts）。所以改匹配规则不需要写迁移，历史归属自己跟上。
    --
    -- 它曾经是流水——"评测时算好存下来，之后再没人碰"。代价是判据一改，
    -- 库里全是按老规矩记的：实测 182 条里 39 条站不住（22 条来自一处错都没有的录音，
    -- 14 条是 n→ŋ 被只讲 l/n 的笔记冒领，剩下的是"标签拍成一个池子"沾上的）。
    -- 当时说"从音素反推不出来"——对，但那是因为**位置和 target 没存**。存上就能反推。
    CREATE TABLE IF NOT EXISTS attempt_note (
      attempt_id INTEGER NOT NULL REFERENCES attempt(id) ON DELETE CASCADE,
      note_id    TEXT NOT NULL,
      PRIMARY KEY (attempt_id, note_id)
    );

    CREATE TABLE IF NOT EXISTS reference_ipa (
      file TEXT PRIMARY KEY,
      raw_ipa TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempt_entry_idx ON attempt(entry_text);
    CREATE INDEX IF NOT EXISTS attempt_error_idx ON attempt_error(attempt_id);
  `);
  return db;
}

export function upsertEntry(db: Database.Database, text: string, words: WordAnalysis[], now: string): void {
  db.prepare(`
    INSERT INTO entries (text, words_json, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(text) DO UPDATE SET words_json = excluded.words_json, updated_at = excluded.updated_at
  `).run(text, JSON.stringify(words), now, now);
}

/**
 * 只换推导结果，**不动 updated_at**。
 *
 * 界面上那一列叫「更新时间」，用户读作"我上次动这个词是什么时候"。
 * 分析器加了新规则、后台把旧词条重算一遍（见 reanalyze.ts），
 * 那不是他做的事，不该把 46 个词条的时间全推到今天。
 */
export function refreshWords(db: Database.Database, text: string, words: WordAnalysis[]): void {
  db.prepare('UPDATE entries SET words_json = ? WHERE text = ?').run(JSON.stringify(words), text);
}

export function getEntry(db: Database.Database, text: string): EntryRow | null {
  const r = db.prepare('SELECT * FROM entries WHERE text = ?').get(text) as any;
  return r ? { text: r.text, words: JSON.parse(r.words_json), createdAt: r.created_at, updatedAt: r.updated_at } : null;
}

export function listEntries(db: Database.Database): EntryRow[] {
  return (db.prepare('SELECT * FROM entries ORDER BY updated_at DESC').all() as any[])
    .map((r) => ({ text: r.text, words: JSON.parse(r.words_json), createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function deleteEntry(db: Database.Database, text: string): AudioRow[] {
  const rows = getAudio(db, text);
  db.prepare('DELETE FROM audio WHERE entry_text = ?').run(text);
  db.prepare('DELETE FROM entries WHERE text = ?').run(text);
  return rows;
}

export function addAudio(db: Database.Database, a: Omit<AudioRow, 'id'>): void {
  db.prepare('INSERT INTO audio (entry_text, word, source, file) VALUES (?, ?, ?, ?)')
    .run(a.entryText, a.word, a.source, a.file);
}

export function getAudio(db: Database.Database, entryText: string): AudioRow[] {
  return (db.prepare('SELECT * FROM audio WHERE entry_text = ?').all(entryText) as any[])
    .map((r) => ({ id: r.id, entryText: r.entry_text, word: r.word, source: r.source, file: r.file }));
}

/**
 * 删掉一条 audio 行。给"把合成音换成真人录音"用（见 /api/entries 里的升级逻辑）。
 * 按 id 删而不是按 (entry, word)：短语里同一个词可能有多行，只该动指定那一条。
 */
export function removeAudioRow(db: Database.Database, id: number): void {
  db.prepare('DELETE FROM audio WHERE id = ?').run(id);
}

// 音频文件名来自 slugify(word)，不同 entry（比如 "black cat" 和 "black"）完全可能共用
// 同一个文件（都落到 black-tts.mp3）。删词条时不能看到一条 audio 行就直接 unlink 对应
// 文件——必须先确认没有其它还在库里的 entry 仍然引用这个文件名，否则会把还在用的音频
// 删掉，且那另一个 entry 之后重新 POST 也不会自动修复（POST 里的"已有音频"判断只看
// DB 行在不在，不检查磁盘上的文件在不在）。
export function audioFileInUse(db: Database.Database, file: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM audio WHERE file = ? LIMIT 1').get(file));
}

// ---- 评测流水 ----

export type AttemptOp =
  | { kind: 'match'; targetIpa: string; heardIpa: string }
  | { kind: 'sub'; targetIpa: string; heardIpa: string }
  | { kind: 'del'; targetIpa: string }
  | { kind: 'ins'; heardIpa: string };

export function logAttempt(db: Database.Database, a: {
  entryText: string;
  /** 这次实际念的是哪个词（短语词条可以只录其中一个）。按词声明范围的笔记按它匹配 */
  target: string;
  at: string; targetIpa: string[]; heardIpa: string[]; ops: AttemptOp[];
  /**
   * 这次是不是**真的每个音都对上了**。
   *
   * **不能从 ops 反推。** ops 里只有确凿的错（低置信度的被上游丢掉了），于是
   * "模型听到别的音但没把握"那种情况 ops 全是 match，反推出来就是全对。
   * 实测 47 次里 6 次判全对，5 次是这么来的——thin [θ ɪ n] → [f ɛ n] 也算成了全对。
   *
   * 所以由调用方按完整对齐结果算好传进来：ops 回答"哪些错该进统计"，
   * clean 回答"这次到底对没对"，两个问题不是一个。
   */
  clean: boolean;
}): number {
  // **位置要在过滤之前数**：match/sub/del 各消耗一个目标音，ins 不消耗——
  // 这跟 judge.ts 里 errorTags 的推法是同一套，两边不一致的话结构标签会整体错位。
  const errors: Array<AttemptOp & { atIndex: number }> = [];
  let ti = 0;
  for (const o of a.ops) {
    if (o.kind !== 'match') errors.push({ ...o, atIndex: ti });
    if (o.kind !== 'ins') ti += 1;
  }
  // 一次评测的流水和它的每处错必须一起成立：只写进流水而错没写进去，排行会少算；
  // 只写错而流水没写，外键就悬空了。
  return db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO attempt (entry_text, target, at, target_ipa, heard_ipa, clean) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(a.entryText, a.target, a.at, a.targetIpa.join(' '), a.heardIpa.join(' '), a.clean ? 1 : 0);
    const ins = db.prepare(
      'INSERT INTO attempt_error (attempt_id, kind, target_ipa, heard_ipa, at_index) VALUES (?, ?, ?, ?, ?)');
    for (const o of errors) {
      ins.run(
        info.lastInsertRowid,
        o.kind,
        'targetIpa' in o ? o.targetIpa : null,
        'heardIpa' in o ? o.heardIpa : null,
        o.atIndex,
      );
    }
    return Number(info.lastInsertRowid);
  })();
}

/**
 * 覆盖这一次录音的笔记归属。
 *
 * `attempt_note` 是**派生**的（内容由错误行 + 笔记推出来，见 reconcile.ts），
 * 所以它只该有一个写入口：评测当场写一次，对账时按同一个判据重写。
 * 先删后插，不是增量——归属变小时（比如某篇笔记不再教得了这处错）也要跟着变小。
 */
export function putAttribution(db: Database.Database, attemptId: number, noteIds: Iterable<string>): void {
  db.transaction(() => {
    db.prepare('DELETE FROM attempt_note WHERE attempt_id = ?').run(attemptId);
    const ins = db.prepare('INSERT OR IGNORE INTO attempt_note (attempt_id, note_id) VALUES (?, ?)');
    for (const id of noteIds) ins.run(attemptId, id);
  })();
}

/**
 * 每篇笔记在**你**身上命中过几次、跨几个词。
 * 判据跟「该补的笔记」同一条（profile.ts 的 worthANote）：次数够、而且不止一个词。
 */
export function noteEvidence(db: Database.Database): Map<string, { count: number; words: number }> {
  const rows = db.prepare(`
    SELECT n.note_id AS id, COUNT(*) AS count, COUNT(DISTINCT a.entry_text) AS words
    FROM attempt_note n JOIN attempt a ON a.id = n.attempt_id
    GROUP BY n.note_id
  `).all() as Array<{ id: string; count: number; words: number }>;
  return new Map(rows.map((r) => [r.id, { count: r.count, words: r.words }]));
}

export interface PhonemeStat {
  kind: 'sub' | 'del' | 'ins';
  targetIpa: string | null;
  heardIpa: string | null;
  count: number;
  lastAt: string;
  /** 出现过这个错的词，最多列几个，给档案里当例词用 */
  words: string[];
  /**
   * 这个错**独占整条转写**的次数——那一次评测里除了它没有别的错。
   *
   * 这是「真短板」和「转写崩了」之间最硬的界线，比"跨了几个词"硬得多：
   * 模型不可能连续十几次在一条其余全对的转写里恰好错同一个位置。
   *   /ɑ/→/æ/ 17 次全在一个词上，但 15 次整条只错这一个音 → 真的
   *   /d/→/t/  6 次全在一个词上，而那几条转写整个是乱的   → 假的
   * 只看"跨几个词"的话，这两个长得一模一样。
   */
  soloCount: number;
}

/** 按"错法 + 涉及的音"聚合排行，最常犯的排前面 */
/**
 * 统计表最多列几条。**导出它**是因为调用方必须知道自己有没有被截断——
 * 一张看着"就这些"的表底下还藏着行，是最容易让人误判的一种呈现。
 */
export const PHONEME_STATS_LIMIT = 20;

export function phonemeStats(db: Database.Database, limit = PHONEME_STATS_LIMIT): PhonemeStat[] {
  const rows = db.prepare(`
    SELECT e.kind, e.target_ipa AS targetIpa, e.heard_ipa AS heardIpa,
           COUNT(*) AS count, MAX(a.at) AS lastAt,
           GROUP_CONCAT(DISTINCT a.entry_text) AS words,
           -- 那一次评测里总共只有这一处错 = 其余的音模型全听对了
           SUM(CASE WHEN (SELECT COUNT(*) FROM attempt_error x WHERE x.attempt_id = e.attempt_id) = 1
                    THEN 1 ELSE 0 END) AS soloCount
    FROM attempt_error e JOIN attempt a ON a.id = e.attempt_id
    GROUP BY e.kind, e.target_ipa, e.heard_ipa
    ORDER BY count DESC, lastAt DESC
    LIMIT ?
  `).all(limit) as Array<Omit<PhonemeStat, 'words'> & { words: string | null }>;
  return rows.map((r) => ({ ...r, words: (r.words ?? '').split(',').filter(Boolean).slice(0, 6) }));
}

/**
 * **这一个词上**他犯过哪些错。跟 phonemeStats 的区别只有一个 WHERE，
 * 但那个 WHERE 正是词条页要的东西。
 *
 * 词条页原来用的是全局统计：只要"你在别处犯过这个错"且"这个词里有那个音"，
 * 那篇笔记就被摆进「这个词的讲解」。实测 click——你在它上面只错过 l→n，
 * 页面却同时摆着「长短元音」，因为你在 **thin** 上错过 ɪ→i，而 click 里有个 /ɪ/。
 * 而折叠那行写的是「你还没在**这个词上**错过」，反过来就是在说外面那些你错过了。
 *
 * 不设 LIMIT：这是一个词的错误，条数天然很少（实测最多的 dopamine detox 也只有十几条），
 * 而截断会让"没错过"和"错过但被截掉"分不开。
 */
export function errorsOnWord(db: Database.Database, entryText: string): PhonemeStat[] {
  const rows = db.prepare(`
    SELECT e.kind, e.target_ipa AS targetIpa, e.heard_ipa AS heardIpa,
           COUNT(*) AS count, MAX(a.at) AS lastAt,
           SUM(CASE WHEN (SELECT COUNT(*) FROM attempt_error x WHERE x.attempt_id = e.attempt_id) = 1
                    THEN 1 ELSE 0 END) AS soloCount
    FROM attempt_error e JOIN attempt a ON a.id = e.attempt_id
    WHERE a.entry_text = ?
    GROUP BY e.kind, e.target_ipa, e.heard_ipa
    ORDER BY count DESC, lastAt DESC
  `).all(entryText) as Array<Omit<PhonemeStat, 'words'>>;
  return rows.map((r) => ({ ...r, words: [entryText] }));
}

export interface WordStat { attempts: number; clean: number; lastAt: string | null }

/** 某个词条练过几次、几次全对 */
export function wordStat(db: Database.Database, entryText: string): WordStat {
  const r = db.prepare(
    'SELECT COUNT(*) AS attempts, COALESCE(SUM(clean), 0) AS clean, MAX(at) AS lastAt FROM attempt WHERE entry_text = ?',
  ).get(entryText) as WordStat;
  return r;
}

/**
 * 这个词的历次录音里，**每个位置上他实际发出的音**及其次数。
 *
 * 用来回答只有历史数据能回答的问题：**参考基准在这个位置上是不是错的？**
 * 基准的前提是"模型对真人录音的转写可信"，而 dopamine 就不可信——第 5 位
 * 词典 /i/、基准 /eɪ/，而他 15 次里发出 /i/ 十次，念对了却被判错 11 次。
 *
 * 判据：基准跟词典不一致的位置上，他反复发出词典那个值且多于基准值，就是基准错了。
 * 只统计 target_ipa 完全相同的流水——不同目标序列位置对不上。
 */
export function heardByPosition(
  db: Database.Database, entryText: string, targetIpa: string[],
): Array<Record<string, number>> {
  const rows = db.prepare(
    'SELECT heard_ipa FROM attempt WHERE entry_text = ? AND target_ipa = ?',
  ).all(entryText, targetIpa.join(' ')) as Array<{ heard_ipa: string }>;
  const out: Array<Record<string, number>> = targetIpa.map(() => ({}));
  for (const r of rows) {
    const heard = r.heard_ipa.split(' ').filter(Boolean);
    // 长度不等说明有增删，位置已经错开，这一条不参与逐位统计
    if (heard.length !== targetIpa.length) continue;
    heard.forEach((p, i) => { out[i][p] = (out[i][p] ?? 0) + 1; });
  }
  return out;
}

/** 一个练了很多次却始终过不去的词 */
export interface StuckWord { text: string; attempts: number; clean: number }

/**
 * **卡住的词**：练了够多次、全对率还是很低的那些。
 *
 * 给 AI 的队列里**词级**的那一半。「该补的笔记」是音素级的，回答不了
 * "dopamine detox 练了 35 次、全对率 11%、三篇讲解都挂着"——那不是缺笔记，
 * 是现有的讲解没起作用。他练的时候不一定开着 AI，这就是留给"等下次"的清单。
 */
/*
 * 实现注记（写在函数外：SQL 是模板字符串，注释里带反引号会把它截断）：
 * **HAVING 里必须写完整的聚合式，不能用 SELECT 里的别名。**
 * clean 既是 attempt 的列名又是这里的别名，SQLite 解析成原始列，判据静默算错。
 */
export function stuckWords(db: Database.Database, minAttempts = 5, maxCleanRate = 0.4): StuckWord[] {
  return db.prepare(`
    SELECT entry_text AS text, COUNT(*) AS attempts, COALESCE(SUM(clean), 0) AS clean
    FROM attempt
    GROUP BY entry_text
    HAVING COUNT(*) >= ? AND CAST(COALESCE(SUM(clean), 0) AS REAL) / COUNT(*) <= ?
    ORDER BY attempts DESC
  `).all(minAttempts, maxCleanRate) as StuckWord[];
}

/** 总览：练了多少次、多少次全对、涉及多少个词 */
export function overallStats(db: Database.Database) {
  return db.prepare(`
    SELECT COUNT(*) AS attempts, COALESCE(SUM(clean), 0) AS clean,
           COUNT(DISTINCT entry_text) AS words, MIN(at) AS firstAt, MAX(at) AS lastAt
    FROM attempt
  `).get() as { attempts: number; clean: number; words: number; firstAt: string | null; lastAt: string | null };
}

// ---- 参考录音的转写缓存 ----

export function getReferenceIpa(db: Database.Database, file: string): string | null {
  const r = db.prepare('SELECT raw_ipa FROM reference_ipa WHERE file = ?').get(file) as { raw_ipa: string } | undefined;
  return r?.raw_ipa ?? null;
}

export function putReferenceIpa(db: Database.Database, file: string, rawIpa: string, at: string): void {
  db.prepare(
    'INSERT INTO reference_ipa (file, raw_ipa, at) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET raw_ipa = excluded.raw_ipa, at = excluded.at',
  ).run(file, rawIpa, at);
}

// ---- 搬家：导出 / 导入 ----

/**
 * 一份可以带走的备份。
 *
 * **只带不可再生的东西。** 音频（54 个 mp3）和参考转写重新查一次词典就有，
 * 塞进来只会让文件从几十 KB 变成几十 MB；`notes/` 跟着 git 走，不需要备份。
 * 真正丢了就没有的是这三样：查过哪些词、每一次录音的判定、复习排到第几档。
 */
export interface Backup {
  version: 1;
  exportedAt: string;
  entries: EntryRow[];
  attempts: Array<{
    entryText: string;
    /** 这次实际念的词。少了它，导进去之后归属只能猜整条 */
    target: string;
    at: string; targetIpa: string; heardIpa: string; clean: number;
    errors: Array<{
      kind: string; targetIpa: string | null; heardIpa: string | null;
      /** 落在第几个音上。结构类笔记的归属靠它 */
      atIndex: number;
    }>;
    // **不带 noteIds**：那是派生的（错误行 + target + notes/ → reconcile.ts），
    // 而 notes/ 跟着 git 走，两边未必是同一版。带上等于把导出那台机器的规则
    // 一起搬过来——实测老备份把 22 条"念对了也记一笔"的证据原样灌进了新机器。
    // 现在导完重算一遍，谁的规则都不用争。
  }>;
}

export function exportBackup(db: Database.Database, now: string): Backup {
  const errs = db.prepare('SELECT * FROM attempt_error').all() as Array<
    { attempt_id: number; kind: string; target_ipa: string | null; heard_ipa: string | null; at_index: number }>;
  const byAttempt = new Map<number, typeof errs>();
  for (const e of errs) {
    if (!byAttempt.has(e.attempt_id)) byAttempt.set(e.attempt_id, []);
    byAttempt.get(e.attempt_id)!.push(e);
  }
  const rows = db.prepare('SELECT * FROM attempt ORDER BY id').all() as Array<
    { id: number; entry_text: string; target: string; at: string;
      target_ipa: string; heard_ipa: string; clean: number }>;
  return {
    version: 1,
    exportedAt: now,
    entries: listEntries(db),
    attempts: rows.map((r) => ({
      entryText: r.entry_text, target: r.target, at: r.at, targetIpa: r.target_ipa,
      heardIpa: r.heard_ipa, clean: r.clean,
      errors: (byAttempt.get(r.id) ?? []).map((e) => ({
        kind: e.kind, targetIpa: e.target_ipa, heardIpa: e.heard_ipa, atIndex: e.at_index,
      })),
    })),
  };
}

/**
 * 这份推导里有没有**人手敲进去的**音标。
 *
 * `ipaOverride` 没有单独存——它就写在那个"词典查不到"的词的 ipa 字段上。
 * 所以判据只能是这个组合：查不到（found: false）而又有音标，那必然是人给的。
 * 来自备份的数据是外部输入，字段可能压根不是字符串，这里不假设。
 */
function hasManualIpa(words: WordAnalysis[]): boolean {
  return words.some((w) => w && !w.found && typeof w.ipa === 'string' && w.ipa.trim() !== '');
}

/**
 * 把备份灌回来。**追加，不覆盖**——同一次录音（同词条 + 同时间戳）已经在库里就跳过。
 *
 * 为什么不是"清空再导入"：那样一次误操作就抹掉本机已有的记录，而这个动作的
 * 典型场景恰恰是"换了台电脑，想把两边合起来"。去重键用 (entry_text, at)：
 * 时间戳精确到毫秒，同一条录音不会有两个。
 *
 * 词条这一路曾经是无条件 upsert，也就是**导进来的直接盖掉本机的**。对普通词
 * 无所谓（两边都是词典算的，一模一样），坏在手工音标上：对面没敲过就是个空串，
 * 一次「合并」把本机敲过的抹掉——而合并正是这个功能唯一的用途。
 * 现在的规则跟复习进度同一条：**谁有手工音标听谁的，都有或都没有就本机赢**。
 * 推导结果不用争，本机会按自己的规则重算（reanalyze.ts）。
 *
 * 笔记归属同理，而且更彻底：备份里**根本不带** noteIds，导完由 reconcile.ts
 * 按本机的 notes/ 重算。老备份里那个字段直接忽略——它是导出那台机器的规则，
 * 不是这台的。
 */
export function importBackup(db: Database.Database, b: Backup): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  const seen = db.prepare('SELECT 1 FROM attempt WHERE entry_text = ? AND at = ? LIMIT 1');
  db.transaction(() => {
    for (const e of b.entries) {
      const cur = getEntry(db, e.text);
      if (cur && (hasManualIpa(cur.words) || !hasManualIpa(e.words))) continue;
      upsertEntry(db, e.text, e.words, e.updatedAt || b.exportedAt);
    }
    for (const a of b.attempts) {
      if (seen.get(a.entryText, a.at)) { skipped += 1; continue; }
      const info = db.prepare(
        'INSERT INTO attempt (entry_text, target, at, target_ipa, heard_ipa, clean) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(a.entryText, a.target, a.at, a.targetIpa, a.heardIpa, a.clean);
      const ins = db.prepare(
        'INSERT INTO attempt_error (attempt_id, kind, target_ipa, heard_ipa, at_index) VALUES (?, ?, ?, ?, ?)',
      );
      for (const er of a.errors) {
        ins.run(info.lastInsertRowid, er.kind, er.targetIpa, er.heardIpa, er.atIndex);
      }
      added += 1;
    }
  })();
  return { added, skipped };
}
