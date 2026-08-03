import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import dayjs from 'dayjs';

/**
 * 复习间隔（天）。
 *
 * **上限是一周，不是一个月。** 1-3-7-14-30 那条是间隔重复的经典梯子，它是照
 * 遗忘曲线来的——测的是"这个事实你还记不记得"。而这一页练的是**舌头的动作**：
 * 一个正在纠的音隔 30 天不碰，回来基本等于从头再来，而且那 30 天里你还在
 * 用错的方式说它。间隔照旧越拉越开（这一点对运动学习同样成立），只是不拉到
 * 一个月开外。
 *
 * 档位数没变（还是 5 档）：改成 4 档的话，磁盘上已有的 rung=4 卡片会在
 * isCardState 那里验不过、被当成坏记录丢掉——这个仓库已经公开，别人的进度
 * 不能因为一次调参就作废。
 */
const RUNGS = [1, 2, 3, 5, 7];

/** 连对几次才升一档 / 才毕业出列 */
const STREAK_TO_ADVANCE = 2;
/**
 * 只有两档，因为**评价不是自己报的**：卡片答成什么样由逐音素评测判
 * （web 的 align.ts `gradeOf`），每个音都对 → remembered，有确凿的错 → forgot，
 * 判不出来则一律不计入进度、根本不发这个请求。
 * 经典 SRS 那个自评的"有点难"在这里没有出处，所以没有第三档。
 */
export type Grade = 'remembered' | 'forgot';
export const GRADES = new Set<Grade>(['remembered', 'forgot']);
export interface CardState {
  rung: number;
  due: string;
  lastReviewed: string | null;
  /**
   * 手动收藏进来的。记它是为了区分**为什么在队列里**：
   * - 录音发错自动进来的（false/缺省）：连续答对爬到顶级之后**毕业出列**
   * - 你自己标星进来的（true）：永远留着，除非你取消收藏
   *
   * 缺省即 false。手工在 review-state.json 里加卡时不用写这个字段。
   */
  starred?: boolean;
  /**
   * 连着答对了几次。**升档和毕业都要连对两次。**
   *
   * 一次念对不等于这个动作稳了——尤其模型自己就不够准：实测辅音 41/42，
   * 元音只有 15/22、低元音 6/10。
   * 拿一次"每个音都对"就把卡片推远一档，等于把模型的噪声当成了进步。
   *
   * 缺省即 0。手工在 review-state.json 里加卡时不用写这个字段。
   */
  streak?: number;
}

// 专门的错误类型，好让调用方（app.ts 的 POST /api/review/:text）能区分"这张卡片压根不
// 存在"（该回 404）和其它失败（比如 save() 写盘出错，该回 500）——两者以前共用同一个
// catch 分支，全被当成 404 "无此卡片" 报出去，把磁盘故障也悄悄吞成了"卡片不存在"。
export class CardNotFoundError extends Error {
  constructor(text: string) {
    super(`no card: ${text}`);
    this.name = 'CardNotFoundError';
  }
}

export function nextState(s: CardState, grade: Grade, today: string): CardState {
  const streak = grade === 'remembered' ? (s.streak ?? 0) + 1 : 0;
  // 连对两次才升档。只对一次就留在原档再练一遍——理由见 CardState.streak
  const rung = streak >= STREAK_TO_ADVANCE ? Math.min(s.rung + 1, RUNGS.length - 1) : grade === 'remembered' ? s.rung : 0;
  return {
    rung,
    due: dayjs(today).add(RUNGS[rung], 'day').format('YYYY-MM-DD'),
    lastReviewed: today,
    starred: s.starred,
    // 升了档就从头攒，没升就把这次也计进去
    streak: streak >= STREAK_TO_ADVANCE ? 0 : streak,
  };
}

/**
 * 这一次答对之后该不该毕业出列。
 *
 * 原来的阶梯**只有入口没有出口**：爬到顶级之后 rung 就卡在 4，卡片永远留在队列里，
 * 一周一次地反复出现。而复习队列是工作集，只进不出的话迟早堆到没人愿意点开。
 *
 * 已经在最高一级、这次又答对 = 这个词你会了，让它出去。手动收藏的除外——
 * 那是你自己要留的，工具不该替你决定它该毕业。
 */
function graduates(s: CardState, grade: Grade): boolean {
  return grade === 'remembered'
    && s.rung >= RUNGS.length - 1
    && (s.streak ?? 0) + 1 >= STREAK_TO_ADVANCE   // 这一次算上，得是连着第二次
    && !s.starred;
}

// 卡片表用**无原型对象**，不是普通 {}。词条文本直接当键用，而英文里就有跟 Object.prototype
// 属性同名的词——"constructor" 在 CMUdict 里（kənˈstrʌktɚ），程序员学发音完全会查它。普通对象上：
//   读：state["constructor"] 命中原型链上的构造函数，恒真 → 卡片永远建不上，静默漏掉
//   写：state["__proto__"] = x 走的是 Object.prototype 的 __proto__ setter，压根不生成自有属性
//       → 卡片凭空消失，delete 也删不掉，还顺手把整个 state 的原型换了
// Object.create(null) 把这两条路一起堵死。
function emptyState(): Record<string, CardState> {
  return Object.create(null) as Record<string, CardState>;
}

// 只认真实存在的日期。光用 /^\d{4}-\d{2}-\d{2}$/ 这种形状正则是不够的——"2026-13-01"
// 能过，而 due() 是按字符串比大小的，"2026-13-01" 比任何真实日期都大，那张卡就再也不会
// 到期，静默消失。"2026-02-30" 同理（Date 会滚到 3 月 2 日）。
function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = dayjs(v);
  return d.isValid() && d.format('YYYY-MM-DD') === v;
}

function isCardState(v: unknown): v is CardState {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.rung === 'number' && Number.isInteger(c.rung) && c.rung >= 0 && c.rung < RUNGS.length
    && isDay(c.due)
    // lastReviewed 缺席也算合法：这是份鼓励用户自己打开看的文件，手写一张新卡时写
    // {"rung":0,"due":"2026-08-01"} 是完全自然的，不该因为少一个恒为 null 的字段就被判废。
    && (c.lastReviewed === undefined || c.lastReviewed === null || typeof c.lastReviewed === 'string')
    && (c.starred === undefined || typeof c.starred === 'boolean')
    && (c.streak === undefined || (typeof c.streak === 'number' && Number.isInteger(c.streak) && c.streak >= 0));
}

/**
 * 把磁盘上那条记录收成一张卡。
 *
 * **只有这一处**。此前 load() 和 cardOnDisk() 各自手挑字段，同一个坑就踩了两次：
 *   · load() 漏了 starred —— 磁盘上还是 true、内存里成了 undefined，而 due() 和
 *     cardOf() 读的都是内存，于是**每次重启，收藏状态就在界面上消失一次**
 *   · cardOnDisk() 漏了 streak —— grade() 的基准取自它，连胜每次都读回 undefined，
 *     卡片永远升不了档
 * 两次都是"加了个字段，忘了在另一处也加"。以后加字段只改这里。
 *
 * 缺省值不填死（starred/streak 保持 undefined）：JSON.stringify 会把它们丢掉，
 * review-state.json 就还是那份人能手写、手改的短文件。读的那几处自己 ?? 兜底。
 */
function toCard(v: CardState): CardState {
  return {
    rung: v.rung,
    due: v.due,
    lastReviewed: v.lastReviewed ?? null,
    starred: v.starred,
    streak: v.streak,
  };
}

// ok=false 只表示"内容不是合法 JSON 对象"（真·损坏）。读文件本身失败（EBUSY/EACCES/
// EPERM——Windows 上杀软扫描时抓一下句柄很常见）必须单独报出来：那不是损坏，把它当损坏处理
// 会走进"备份 + 用内存覆盖"的破坏性分支，几毫秒后锁一放开，整份复习历史就被内存快照顶掉了。
interface RawRead { raw: Record<string, unknown>; ok: boolean; ioError: Error | null }

function readRaw(file: string): RawRead {
  if (!existsSync(file)) return { raw: Object.create(null), ok: true, ioError: null };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { raw: Object.create(null), ok: false, ioError: e as Error };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { raw: Object.create(null), ok: false, ioError: null };
    return { raw: Object.assign(Object.create(null), parsed), ok: true, ioError: null };
  } catch {
    return { raw: Object.create(null), ok: false, ioError: null };
  }
}

// 整份文件读不出来时，先把它原样挪到一边再继续。这是除 notes/ 外唯一不可再生的数据，
// 而下面每次写入都会覆盖整个文件——不留副本的话，一次断电写坏 + 一次正常评分，几个月的
// 复习进度就没了，而用户只会看到"今日复习完成"，毫无察觉。
// required=true 时备份失败必须抛出：那种场景下备份是紧随其后那次**破坏性写入的前提**，
// 只打一行 warn 就照写不误，等于在没有任何副本的情况下覆盖掉用户唯一不可再生的数据。
// 构造函数则相反——它根本不写盘，备份只是尽力留个副本，失败了绝不能让 new ReviewStore()
// 抛出去：那会直接导致服务起不来。
function backupCorrupt(file: string, required: boolean): void {
  if (!existsSync(file)) return;
  const bak = `${file}.corrupt-${Date.now()}`;
  try {
    copyFileSync(file, bak);
    console.warn(`[review] 原文件已备份到 ${bak}，可从中手工找回进度`);
  } catch (e) {
    if (required) throw e;
    console.warn(`[review] 备份原文件失败（${(e as Error).message}），本次不改动它`);
  }
}

// 写入走 tmp + rename：rename 是原子的，中途断电/Ctrl+C 只会留下一个 .tmp，最终文件要么
// 是旧的完整内容、要么是新的完整内容，不会出现被截断的半个 JSON。
function atomicWrite(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw e;
  }
}

export class ReviewStore {
  private state: Record<string, CardState> = emptyState();
  // 同一次损坏只备份一次：构造时读不出来会备一份，而在第一次写入把文件覆盖掉之前，
  // persist 重读到的还是那份坏文件，不去重的话每写一次就多攒一个 .corrupt-<ts> 副本。
  private backedUp = false;

  constructor(private file: string) {
    const { raw, ok, ioError } = readRaw(file);
    if (ioError) {
      // 读不到 ≠ 内容坏了。不备份（根本读不出来）、也不动它，按空进度起步等下次重启再说。
      console.warn(`[review] 读不到 review-state.json（${ioError.message}），按空进度起步，不会改动该文件`);
      return;
    }
    if (!ok) {
      console.warn('[review] review-state.json 内容不是合法 JSON 对象，按空进度起步');
      this.backupOnce(false);
      return;
    }
    for (const [text, value] of Object.entries(raw)) {
      if (isCardState(value)) {
        this.state[text] = toCard(value);
      } else {
        // 只是不往内存里放，**不从磁盘上删**。校验不过的记录仍然原样留在文件里（见 persist），
        // 用户可以照着这条告警自己去修。以前是丢进内存就等于丢了：下一次写入会把整个
        // state 覆盖回文件，那条记录连同它的 rung/lastReviewed 一起蒸发。
        // 措辞必须准确：这条记录会原样留在文件里等你修，但如果你**重新讲一次这个词**
        // （POST /api/entries），addCard 会用一张全新的 rung 0 卡片把它覆盖掉。
        console.warn(`[review] 忽略 review-state.json 里格式不对的记录 "${text}"：${JSON.stringify(value)}（暂时原样留在文件里可手工修正；但重新讲一次这个词会用新卡覆盖它）`);
      }
    }
  }

  // 每次只写自己动的那一个键：先重新读一遍磁盘上的内容，把这次的改动盖上去，再整体原子
  // 写回。这样两件事同时成立——校验不过的记录不会被抹掉；服务运行期间用户手工改了别的
  // 词，也不会被内存里的旧快照覆盖（以前是把构造时读到的整份快照直接写回去）。
  private persist(text: string, value: CardState | undefined): void {
    const { raw, ok, ioError } = readRaw(this.file);
    // 读不出来（文件被锁）时宁可这次写入失败也不要写：那不是损坏，硬写就是拿内存快照
    // 覆盖一份其实完好的文件。
    if (ioError) throw ioError;
    if (!ok) this.backupOnce(true);

    // 内存 ∪ 磁盘，**磁盘优先**。两个方向都必须成立：
    //   磁盘有内存没有（用户手工加的、校验没过被忽略的）→ 保留，不能被这次写入抹掉
    //   内存有磁盘没有（文件被 git checkout 还原成 {}、被截断、被删）→ 用内存补回来
    // 只取磁盘那一份的话，一次 `git checkout .`（这文件是 git 跟踪的）就能让下一次评分
    // 把其余所有卡片从磁盘上抹干净，而且悄无声息。
    const next: Record<string, unknown> = Object.assign(emptyState(), this.state, ok ? raw : {});
    const restored = Object.keys(this.state).filter((k) => ok && !(k in raw));
    if (restored.length > 0) {
      console.warn(`[review] 磁盘上缺少 ${restored.length} 张服务已知的卡片（${restored.slice(0, 5).join('、')}${restored.length > 5 ? '…' : ''}），已按内存补回。若你是有意手工删卡，请在服务停止时操作`);
    }

    if (value === undefined) delete next[text];
    else next[text] = value;
    atomicWrite(this.file, next);
    // 写成功之后磁盘上就是一份完好的文件了。此后若再出现损坏，那是**另一次**事故，应该
    // 重新备份——backedUp 只用于给"同一次损坏"去重，不能变成整个进程生命周期的一次性闸门。
    this.backedUp = false;
  }

  private backupOnce(required: boolean): void {
    if (this.backedUp) return;
    this.backedUp = true;
    backupCorrupt(this.file, required);
  }

  /** 磁盘上这个词是否已经有一张合法卡片（运行期间被外部加进来/改过的） */
  private cardOnDisk(text: string): CardState | null {
    const { raw, ok } = readRaw(this.file);
    if (!ok) return null;
    const v = raw[text];
    return isCardState(v) ? toCard(v) : null;
  }

  /**
   * 把一个词加进复习队列。
   *
   * @param starred 手动收藏进来的。已经在队列里的卡片再调一次，只会把 starred 补上去
   *   （比如先因为发错自动进来、后来你又标了星），不会重置它已经爬到的级别。
   */
  addCard(text: string, today: string, starred = false): void {
    const inMemory = this.state[text];
    if (inMemory) {
      // 已经在队列里：只补 starred，绝不重置进度
      if (starred && !inMemory.starred) this.setStarred(text, true);
      return;
    }
    // 内存里没有不代表磁盘上没有：写入路径是以磁盘为准的（persist 每次重读），存在性判断
    // 却只看内存的话，两边一分叉就会丢数据——服务运行期间磁盘上多出一张攒了几个月的卡
    // （用户手工加的/改的），再讲一次这个词就会被打回 rung 0。
    const existing = this.cardOnDisk(text);
    if (existing) {
      this.state[text] = existing;
      if (starred && !existing.starred) this.setStarred(text, true);
      return;
    }

    const card: CardState = {
      rung: 0,
      due: dayjs(today).add(1, 'day').format('YYYY-MM-DD'),
      lastReviewed: null,
      starred,
    };
    // 先落盘、成功了再改内存。反过来的话，一次写盘失败（磁盘满、权限、父目录没了）会让
    // 内存跑到磁盘前面：调用方重试时 addCard 看内存以为"已经有了"直接 return，于是永远
    // 不再尝试写入，而 due() 照样把这张根本没落盘的卡片报出来。
    this.persist(text, card);
    this.state[text] = card;
  }

  removeCard(text: string): void {
    this.persist(text, undefined);
    delete this.state[text];
  }

  /**
   * 标星 / 取消标星。取消标星时如果这张卡本来就只是因为标星才在队列里（从没答对过、
   * 也没有错误记录），它就该直接出列——留一张没有任何理由的卡是纯粹的噪音。
   * 但这里判断不了"有没有错误记录"（那是 db 的事），所以只做标记，出列与否由调用方决定。
   */
  setStarred(text: string, starred: boolean): CardState {
    const cur = this.cardOnDisk(text) ?? this.state[text];
    if (!cur) throw new CardNotFoundError(text);
    const next: CardState = { ...cur, starred };
    this.persist(text, next);
    this.state[text] = next;
    return next;
  }

  /** 队列里所有卡片的词，不管到没到期。启动时用来找出指向已删词条的孤儿卡 */
  dueAll(): string[] {
    return Object.keys(this.state);
  }

  /** 这个词在不在队列里、是不是收藏的 */
  /** 整份进度，用于导出备份。返回拷贝，调用方改它不会影响内部状态 */
  snapshot(): Record<string, CardState> {
    return JSON.parse(JSON.stringify(this.state)) as Record<string, CardState>;
  }

  /**
   * 把备份里的进度并进来，返回并入了几张。
   *
   * **本机已有的那张赢**，不覆盖：这个动作的典型场景是"换了台电脑想合起来"，
   * 而本机的进度是你刚刚练出来的，导入一份旧备份不该把它推回去。
   * 形状不对的条目直接跳过——宁可少并一张，也不要让一个坏对象进到复习队列里，
   * 那会变成一张每天出现、点开就崩的卡。
   */
  merge(incoming: unknown): number {
    if (!incoming || typeof incoming !== 'object') return 0;
    let n = 0;
    for (const [text, card] of Object.entries(incoming as Record<string, unknown>)) {
      if (this.state[text]) continue;                       // 本机已有，不动
      // ── 校验和收字段都走跟加载同一套 ──
      //
      // 原来这里自己写了一份，两处都出问题：
      //   · 字段是**手挑**的（rung/due/lastReviewed/starred），于是 streak 并不过来，
      //     导入的卡片连胜从 0 重新数。这个文件为手挑字段已经踩过两次
      //     （load 漏 starred、cardOnDisk 漏 streak），第三处不能再犯。
      //   · 校验比 isCardState **松**：只查 rung 是数、due 是串，
      //     于是 rung=99 或 due="不是日期" 能被写进来，而下次启动加载时
      //     isCardState 判它废、丢掉并告警——等于并进来一张下次就消失的卡。
      if (!isCardState(card)) continue;
      const merged = toCard(card);
      // ── 先落盘、成功了再改内存。跟 addCard / grade 同一个顺序 ──
      //
      // 反过来（先改内存）有两个后果：
      //   · 一次写盘失败会让内存跑到磁盘前面，而调用方看内存以为"已经有了"
      //   · persist 里那句「磁盘上缺少 N 张服务已知的卡片」会被误触发——它拿
      //     内存跟磁盘比，而刚写进内存的这张当然还不在磁盘上。实测：
      //     全新机器导入一份 30 张卡的备份，会打 30 句「磁盘上缺少…已按内存补回。
      //     若你是有意手工删卡，请在服务停止时操作」——什么都没缺，全是这么来的。
      this.persist(text, merged);
      this.state[text] = merged;
      n += 1;
    }
    return n;
  }

  cardOf(text: string): CardState | undefined {
    return this.state[text];
  }

  due(today: string): { text: string; due: string; starred: boolean }[] {
    return Object.entries(this.state)
      .filter(([, s]) => s.due <= today)
      .map(([text, s]) => ({ text, due: s.due, starred: s.starred ?? false }))
      .sort((a, b) => a.due.localeCompare(b.due));
  }

  /** @returns 新状态；已毕业出列则返回 null */
  grade(text: string, grade: Grade, today: string): CardState | null {
    // 基准取磁盘上的当前值（拿不到才退回内存）。理由跟 addCard 里那段一样：写入是以磁盘
    // 为准的，判断/计算却用内存快照的话，服务运行期间用户手工改过的那张卡会被按旧 rung
    // 重新算一遍写回去，手工改动无声消失。两边必须用同一个事实来源。
    const cur = this.cardOnDisk(text) ?? this.state[text];
    if (!cur) throw new CardNotFoundError(text);
    // 已经在顶级又连对两次：毕业出列，别让它一周一次地永远回来
    if (graduates(cur, grade)) {
      this.removeCard(text);
      return null;
    }
    const next = nextState(cur, grade, today);
    this.persist(text, next);      // 同上：先落盘，成功了再改内存
    this.state[text] = next;
    return next;
  }
}
