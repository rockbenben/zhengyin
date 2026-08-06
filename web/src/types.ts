// 与服务端响应形状一一对应的类型定义。
//
// 来源（务必对照，不要凭空补字段）：
//   server/src/db.ts            WordAnalysis, AudioRow
//   server/src/notes.ts         Note（severity 取值）
//   server/src/review.ts        Grade, CardState, ReviewStore.due()
//   server/src/analysis/diff.ts PhonemeSub
//   server/src/analysis/match.ts NoteHit（matched 字段）
//   server/src/app.ts           各路由 c.json(...) 的实际返回结构（entryDetail() 等）

export type Severity = 'confirmed' | 'watch' | 'info';
export type AudioSource = 'mw' | 'tts';
export type Grade = 'remembered' | 'forgot';

// server/src/db.ts WordAnalysis —— **全部必填**，那边有一段讲为什么不再有可选字段
export interface WordAnalysis {
  word: string;
  found: boolean;
  arpabet: string[];
  ipa: string;
  tags: string[];
  // 逐音素归属，跟 arpabet 同下标一一对应：phoneIpa[i] 是 arpabet[i] 的 IPA 符号，
  // phoneTags[i] 是这个音素位置贡献的 tag 列表（服务端 attributeTags() 算出来的，
  // 前端不再自己重算音系规则）。
  phoneIpa: string[];
  phoneTags: string[][];
  /** 逐音节的音素下标分组 */
  syllables: number[][];
  /**
   * 逐音节的重音级别：1 主重音、2 次重音、0 轻读。跟 syllables 同下标。
   *
   * 为什么不能压成"主重音在第几节"一个下标：那只标出主重音一个位置，剩下的默认成
   * "轻读"——而 dopamine 是 1-0-2，词尾 -mine 是**次重音**、元音是满的 /miːn/。
   * 按"非主重音即轻读"画出来，等于在屏幕上说了一句假话。
   */
  syllableStress: number[];
}

// server/src/analysis/diff.ts PhonemeSub
export interface PhonemeSub {
  targetIpa: string;
  heardIpa: string;
}

// GET /api/entries -> { entries: EntryListItem[] }
// server/src/app.ts app.get('/api/entries', ...)
export interface EntryListItem {
  text: string;
  ipa: string;
  updatedAt: string;
  noteCount: number;
  audioSource: AudioSource | null;
}

// entryDetail() 里 notes 数组每一项
// server/src/app.ts entryDetail()
export interface EntryDetailNote {
  id: string;
  title: string;
  severity: Severity;
  matched: string[];
  markdown: string;
  /**
   * 跟**这个词**有关吗——摆在外面还是收进折叠里。
   *
   * 只看"这个词里有没有这个音"不够：dopamine 里有 /n/，于是 l-vs-n 也挂上来了，
   * 而这个词里根本没有 /l/。也不能只看 severity，那是全局的（他在 click 上错过 l/n）。
   * 服务端的判据带方向：**这篇教得了一处你真犯过的错，而那处错的目标音就在这个词里**。
   */
  relevant: boolean;
  /**
   * 是哪几处错把它拉到外面来的（`l→n` 这样）。讲词的笔记和折叠里的都是空数组。
   *
   * 有它才说得出**真实理由**：小字原来一律是「因为这个词里有 l」，
   * 那说的是"怎么匹配上的"；而摆在外面的理由是"你在这儿把 l 念成了 n"。
   */
  becauseOf: string[];
}

// GET /api/entries/:text、POST /api/entries 的响应
// server/src/app.ts entryDetail()
export interface EntryDetail {
  text: string;
  createdAt: string;
  words: WordAnalysis[];
  audio: { word: string; source: AudioSource; url: string }[];
  phraseAudio: { source: AudioSource; url: string } | null;
  notes: EntryDetailNote[];
  /** 这个词的复习状态；不在队列里则为 null */
  review: CardState | null;
}

// GET /api/notes 里 groups[severity] 数组每一项
// server/src/app.ts app.get('/api/notes', ...)
/** 素材库把笔记摆在哪一格。判据在 server/src/shelf.ts，前端只照着分段 */
export type Shelf = 'consonant' | 'vowel' | 'structure' | 'word';

export interface NoteListItem {
  id: string;
  title: string;
  severity: Severity;
  triggers: string[];
  exampleCount: number;
  /** 这篇管的是什么：音素笔记是 IPA，结构笔记是原始标签，讲词的是那几个词 */
  covers: string[];
  /** 素材库里的位次。watch/info 两组拼起来之后按它排回服务端定的顺序 */
  order: number;
  shelf: Shelf;
  /** 辅音架上的部位（唇→喉）。其余为 null */
  place: string | null;
  placeLabel: string | null;
}

// GET /api/notes -> { groups: NoteGroups }
export interface NoteGroups {
  confirmed: NoteListItem[];
  watch: NoteListItem[];
  info: NoteListItem[];
}

// GET /api/notes/:id 的响应
// server/src/app.ts app.get('/api/notes/:id', ...)
export interface NoteDetail {
  id: string;
  title: string;
  severity: Severity;
  triggers: string[];
  markdown: string;
  examples: string[];
}

// GET /api/review/due 里 cards 数组每一项
// server/src/review.ts ReviewStore.due()
/** POST /api/review/:text 的响应。graduated=true 表示这张卡已经出列 */
export interface GradeResult { card: CardState | null; graduated: boolean }

export interface ReviewCard {
  text: string;
  due: string;
  /** 手动收藏进来的。收藏的卡片不会自动毕业出列 */
  starred: boolean;
}

// server/src/review.ts CardState；也是 POST /api/review/:text 的响应形状
export interface CardState {
  rung: number;
  due: string;
  lastReviewed: string | null;
  /** 手动收藏进来的。收藏的卡片不会自动毕业出列 */
  starred?: boolean;
  /** 连着答对了几次。升档和毕业都要连对两次 */
  streak?: number;
}

// POST /api/asr 里 notes 数组每一项（不含 matched/markdown，比 EntryDetailNote 少两个字段）
// server/src/app.ts app.post('/api/asr', ...)
export interface AsrNoteHit {
  id: string;
  title: string;
  severity: Severity;
}

// POST /api/asr 的响应。注意：该接口不再接收音频，body 是 { target, heard } 两个已识别好的文本，
// 由服务端做逐词音素 diff + 笔记命中（语音识别本身在浏览器端完成，见 Task 17）。
// server/src/app.ts app.post('/api/asr', ...)
export interface AsrResult {
  match: boolean;
  subs: PhonemeSub[];
  notes: AsrNoteHit[];
}

/**
 * GET /api/pronounce/health。
 * ok  = 边车这一刻起没起来
 * uv  = 这台机器上有没有 uv。**没有的话边车永远起不来**，界面得立刻说，别让人等
 */
export interface PronounceHealth { ok: boolean; uv: boolean }

/** GET/PUT/DELETE /api/settings/mw-key 的响应（server/src/app.ts）。masked 只有末 4 位，完整 key 绝不下发 */
export interface MwKeyState {
  configured: boolean;
  masked: string | null;
}

/** GET/PUT /api/settings/model 的响应（server/src/models.ts 的 modelState） */
export interface ModelOption {
  id: string;
  label: string;
  sizeMb: number;
  note: string;
  /** 本地 data/models/ 下已经有打包好的 tar.gz */
  downloaded: boolean;
}
export interface ModelState {
  selected: string;
  /** 选中模型的 tar.gz 文件名，前端据此拼 /api/model/<file>，不再写死 */
  file: string;
  options: ModelOption[];
}

/**
 * GET /api/confusions/:word 的一条对比项（server/src/analysis/confusions.ts 的 Contrast）。
 * word 跟 target 只差第 index 个音素：target 那里是 targetIpa，word 那里是 partnerIpa。
 * 评测就是拿这两个词做二选一，谁赢等于回答"你第 index 个音发的是哪个"。
 */
export interface Contrast {
  word: string;
  index: number;
  targetIpa: string;
  partnerIpa: string;
}

/**
 * POST /api/pronounce 的一步对齐（server/src/analysis/diff.ts 的 AlignOp + sure）。
 *
 * sure = 模型对这一步有把握（del 恒 true——"这个音没出现"谈不上把握程度）。
 * 判定在服务端做，前端一律读它、不许再跟 conf 比大小；缘由见 server/src/analysis/espeak.ts
 * 的 CONFIDENT。设为**必填**是故意的：谁再手造 op，编译器会逼他想清楚这个字段谁给。
 */
export type AlignOp =
  | { kind: 'match'; targetIpa: string; heardIpa: string; conf?: number; sure: boolean }
  | { kind: 'sub'; targetIpa: string; heardIpa: string; conf?: number; sure: boolean }
  | { kind: 'del'; targetIpa: string; sure: boolean }
  | { kind: 'ins'; heardIpa: string; conf?: number; sure: boolean };

/** POST /api/pronounce 的响应：音素级评测的结果 */
export interface PronounceResult {
  target: string;
  targetIpa: string[];
  /** 逐词的音素，短语时用来把音素带按词分段（targetIpa 是它们首尾相接的结果） */
  words: Array<{ word: string; ipa: string[] }>;
  /** 归一化到本项目 IPA 之后，模型实际听到的音素序列 */
  heardIpa: string[];
  /** 边车原始输出，出问题时方便对照（正常不展示） */
  rawIpa: string;
  /**
   * 这次是跟什么比的。
   * reference = 跟真人录音过同一个模型的转写比（模型偏置两边抵消，可信度高）
   * dictionary = 只跟词典音标比（没有真人录音时的退路；模型在元音上的系统性偏置会掺进来）
   */
  comparedWith: 'reference' | 'dictionary';
  // ── 下面三个是基准的**校准细节**：诊断用，界面刻意一个都不渲染 ──
  //
  // 别以为是接线漏了。drift 和 repaired 都做过界面提示，两版都撤了：
  //   ·「这把尺子有点歪，参考转写跟词典差 3 处」——差异本身就是基准在干活
  //     （book 的 /ʊ/ 被模型听成 /æ/，两边抵消），把它当故障报是把正常当异常。
  //     而且"这把尺子准不准"是工具该自己解决的问题，不该转嫁给使用者（8d2f4bd）
  //   ·「参考音有 N 处已按你的录音改回词典值」——纠正修的正是"你以为念对了、
  //     工具却说错"那种情况，而修完之后那种情况就不会发生，所以这行字没有听众，
  //     只有噪音；一个单词下面挂一长串说明，喧宾夺主（e911d77）
  //
  // 要看它们就 curl /api/pronounce。改这三个字段的渲染之前先读那两条提交。
  // Recorder.test.tsx 的「基准的校准细节不进评测流」钉着这件事，加回去会红。

  /** 参考转写（模型对真人录音的转写）。comparedWith 为 dictionary 时是 null */
  referenceIpa: string[] | null;
  /** 参考转写跟词典音标不一致的位置。不一致是常态，不是故障 */
  baselineDrift: number[];
  /**
   * 参考转写里被**你自己的录音**纠正过来的位置。
   * 在基准跟词典不一致的地方，如果你反复发出词典那个值、而且比发出基准值更多，
   * 那多半是基准错了。实测 dopamine 第 5 位：词典 /i/、基准 /eɪ/，你 15 次发出 /i/ 十次。
   */
  baselineRepaired: Array<{ index: number; from: string; to: string; times: number }>;
  /**
   * 这次有没有沉淀进发音档案和复习队列。背景太吵时结果照给（你需要反馈），
   * 但不落盘——那批数据会变成"你的习惯性短板"，而它记的其实是当时房间里的噪声。
   * **false 时界面必须说出来**：静悄悄地不计入比计入更糟。
   */
  recorded: boolean;
  /** recorded 为 false 时的原因，直接显示给用户 */
  notRecordedReason: string | null;
  align: AlignOp[];
  notes: Array<{
    id: string; title: string; severity: Severity;
    /** 笔记里"该怎么发"的那几节，直接展示在错误旁边（server/src/analysis/guidance.ts） */
    guidance: Array<{ heading: string; body: string }>;
  }>;
}

/** GET /api/stats：评测积累的统计（server/src/db.ts 的 overallStats / phonemeStats / stuckWords） */
export interface StatsResult {
  overall: { attempts: number; clean: number; words: number; firstAt: string | null; lastAt: string | null };
  /**
   * 卡住的词：练了 ≥5 次、全对率仍 ≤40%。
   * 音素统计说"你 /n/ 错了 21 次"，这个说"dopamine detox 你练了 54 次还是过不去"——
   * 对只用网页的人，后者才直接回答"我今天该练什么"。
   */
  stuck: Array<{ text: string; attempts: number; clean: number }>;
  phonemes: Array<{
    kind: 'sub' | 'del' | 'ins';
    targetIpa: string | null;
    heardIpa: string | null;
    count: number;
    lastAt: string;
    /**
     * 值不值得为它单写一篇音素笔记。**服务端算好的**（profile.ts 的 worthANote：
     * ≥3 次、且跨 ≥2 个词），前端只渲染结论——判据留在前端会长出第二份，
     * 而它一度真的长出来了：同一句「这些音反复出错」在发音档案里是 2 条、
     * 在统计页上是 14 条。
     */
    worthANote: boolean;
    words: string[];
    /** 覆盖到这个音的笔记；空数组 = 这个音还没人教过，该去问 AI */
    notes: Array<{ id: string; title: string }>;
  }>;
}

/** GET /api/articulation：发音部位表（server/src/analysis/articulation.ts） */
export interface Consonant {
  kind: 'consonant'; ipa: string;
  place: string; manner: string; voiced: boolean;
  /** 软腭下降、气流走鼻腔。/n/ 与 /l/ 唯一的差别 */
  nasal: boolean;
}
export interface Vowel {
  kind: 'vowel'; ipa: string;
  /** 都已归一到 0–1，前端直接当百分比 */
  height: number; back: number; rounded: boolean;
  glideTo: { height: number; back: number } | null;
}
/** 这个音具体怎么发。落到身体动作上（server/src/analysis/articulation.ts 的 HOW_TO） */
export type Articulation = (Consonant | Vowel) & { howTo: string | null };
export interface ArticulationTable {
  places: Array<{ id: string; label: string }>;
  manners: Record<string, string>;
  phones: Articulation[];
}

/**
 * GET /api/phonemes：音素表索引（server/src/app.ts）。
 * exampleCount/noteCount 让索引页能标出"库里有几个词含它、有几篇笔记讲它"。
 * noteCount 只数 triggers 命中的笔记——讲词的笔记（Note.words）不算，那正是要分开的东西。
 */
export interface PhonemeList {
  places: Array<{ id: string; label: string }>;
  manners: Record<string, string>;
  /** 元音格子的两根轴。跟 places/manners 一样由服务端定（articulation.ts） */
  vowelRows: Array<{ id: string; label: string }>;
  vowelCols: Array<{ id: string; label: string }>;
  phones: Array<Articulation & {
    exampleCount: number; noteCount: number;
    /** 元音落在哪一格；辅音没有这两个字段（它们有 place/manner） */
    row?: string; col?: string;
  }>;
}

/** GET /api/phonemes/:ipa：一个音素的文档 */
export interface PhonemeDetail {
  phone: Articulation;
  places: Array<{ id: string; label: string }>;
  manners: Record<string, string>;
  /** 库里含这个音的词条 */
  examples: Array<{ text: string; ipa: string }>;
  /** 真正讲这个音的笔记（只认 triggers） */
  notes: Array<{ id: string; title: string; severity: Severity }>;
}

/** GET/POST /api/user、POST /api/users 的响应：整机唯一的「当前用户」+ 全部用户名单 */
export interface UserInfo { current: string; users: string[] }
