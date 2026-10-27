import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import chokidar, { type FSWatcher } from 'chokidar';
import { IPA, parsePhones } from './analysis/phones.js';
import { LEGAL_ONSETS } from './analysis/syllables.js';

export type Severity = 'confirmed' | 'watch' | 'info';

/** 笔记来自哪一根：随应用发布的 / 旧文件夹 / 本机可写 */
export type NoteSource = 'shipped' | 'legacy' | 'local';
export interface NoteRoot {
  dir: string;
  source: NoteSource;
}

export interface Note {
  id: string; title: string; triggers: string[];
  /**
   * 这篇笔记讲的是**哪几个词**（小写、跟词条 text 同形）。
   *
   * 为什么要有它：在只有 triggers 的时候，一篇讲词的笔记想让自己出现，**只能去声明音素
   * trigger**——混类是被数据结构逼出来的。实际后果：dopamine 那篇（讲的是这个词的重音
   * 和 -ine 读法）声明了 phoneme:aɪ，于是 light / night / fine / time 全都会弹出它，
   * 而点音素 aɪ 跳过去看到的是"dopamine 的词尾 /miːn/"——跟 aɪ 这个音毫无关系。
   * 更荒谬的是 aɪ 在那篇里的身份恰恰是**念错了才会得到的音**。
   *
   * 分工从此是明确的：
   *   triggers（phoneme:/cluster-onset:/...） = 这是一节**关于某个音**的课，
   *     凡是含这个音的词都该看到，点音素也该跳到它
   *   words = 这是**这个词**的问题（重音位置、拼写陷阱、词尾连缀），
   *     只在这几个词的页面出现，绝不因为别的词碰巧含同一个音而弹出来
   *
   * 两者都为空的笔记不会匹配任何东西，启动时会告警。
   */
  words: string[];
  /**
   * 这篇笔记还教了「念成什么」——只写 IPA 符号，不带 `phoneme:` 前缀。
   *
   * **为什么它必须跟 triggers 分开。** triggers 回答的是「这是关于哪个音的课」，
   * 决定这篇出现在哪些词条页、点哪个音素跳到它；所以 AGENTS.md 明写着
   * **「念错了才会得到的那个音，不该当 trigger」**——θ 那篇声明 `phoneme:s` 会让它
   * 弹在每一个含 /s/ 的词上，dopamine 那篇声明 `phoneme:aɪ` 真的把 light/night/fine
   * 全弄脏过。
   *
   * 但「报错时哪篇教得了这处错」问的是另一件事，而它**必须**知道错法：
   *   · l-vs-n 声明了 phoneme:n，可它一个字没提后鼻音 → 不该认领 n→ŋ
   *   · th-vs-s 只声明 phoneme:θ（按上面那条规矩），却正是讲 θ→s 的那篇 → 该认领
   * 两处都只看 triggers 的话，这两个要求直接打架：一边要笔记别声明错法，
   * 一边要笔记声明了错法才算数。实测代价——POST /api/pronounce 报出 θ→s，notes 返回 []。
   *
   * 所以错法单独放这里：**只影响"这处错谁来讲"，不影响这篇出现在哪。**
   * 写法 `contrasts: [s, f]`。缺省即空数组，绝大多数笔记不需要它——
   * 双向混淆（l/n、ɑ/æ、n/ŋ）两边都是真实目标音，本来就该两个都写进 triggers。
   */
  contrasts: string[];
  /**
   * **不再从 frontmatter 读**，由 profile.ts 的 severityOf() 按使用者自己的评测记录推。
   * 留在类型里是因为它仍然是「笔记在界面上算什么档次」这件事的载体，
   * 只是那个判断的依据换了地方——从"写笔记的人怎么说"换成"你的数据怎么说"。
   * NoteStore 里一律是 'info'（资料），服务这一层再按证据换成 confirmed / watch。
   */
  severity: Severity;
  markdown: string; file: string;
  /** 这篇笔记来自哪一根。同名时高优先级胜出，界面上也据此标「随附 / 本机」。 */
  source: NoteSource;
}

const SEVERITIES = new Set(['confirmed', 'watch', 'info']);

// trigger 词表中，与 phoneme:/cluster-onset: 无关的固定标签
// （features.ts 的 attributeTags 里按条件字面量 push 的那几个）。
// **加新标签只改这里**——下面那条告警文案是从这个 Set 生成的，不再手抄一份。
const STATIC_TRIGGERS = new Set(['clear-l', 'dark-l', 'flap-t', 'final-voiced']);

// 一些 IPA 符号和外观相似的 ASCII 字符容易被手写笔记误用（比如 IPA 的 script-g "ɡ" U+0261
// 常被误输成 ASCII "g" U+0067）。用于生成 "did you mean" 提示，以及把源码里手写的合法
// onset 表规整成真正会被 extractTags 产出的 IPA 形式，避免同一类字符混淆重复出现却被漏检。
const ASCII_IPA_LOOKALIKES: Record<string, string> = { g: 'ɡ' };

function withLookalikesReplaced(s: string): string {
  let out = '';
  for (const ch of s) out += ASCII_IPA_LOOKALIKES[ch] ?? ch;
  return out;
}

// phoneme:<ipa> 的合法取值：不能直接拿 Object.values(IPA)——parsePhones() 在查完 IPA 表之后
// 还会按重音再改写一次 ipa（AH0→ə、ER0→ɚ、ER1/ER2→ɝ），IPA 表本身只有 AH→ʌ、ER→ɝ 两条静态
// 映射，会漏掉 ə/ɚ 这两个 parsePhones 真实会产出、笔记也真实会匹配上的音素。这里改成把 IPA
// 表里每个 ARPAbet key 分别配上 0/1/2 三种重音，真的跑一遍 parsePhones()，用它实际吐出的 ipa
// 值集合当作"合法取值"——以后 parsePhones 里再加别的重音相关改写，这份集合会自动跟着变，不用
// 再手动同步第二份列表（两处编码同一份知识、后来悄悄漂移，这类 bug 在这个项目里已经不是第一次）。
const ARPABET_STRESS_VARIANTS = Object.keys(IPA).flatMap((base) => [0, 1, 2].map((s) => `${base}${s}`));
const ALL_PHONES = parsePhones(ARPABET_STRESS_VARIANTS);
const VALID_PHONEMES = new Set(ALL_PHONES.map((p) => withLookalikesReplaced(p.ipa)));
// coda 连缀里只可能出现辅音。同一份来源，不另写一张表。
const VALID_CONSONANTS = new Set(
  ALL_PHONES.filter((p) => !p.isVowel).map((p) => withLookalikesReplaced(p.ipa)),
);

/**
 * 把 "ks"、"ndʒ" 这类首尾相接的 IPA 串拆回单个辅音，拆不开就返回 null。
 *
 * **必须最长匹配优先**：tʃ / dʒ 是单个辅音（两个字符），逐字符拆会把 "tʃ" 拆成
 * t + ʃ——那两个各自也是合法辅音，于是一个写错的 trigger 反而校验通过。
 * 连缀至少两个辅音，只有一个的话该写 phoneme:。
 */
function splitConsonants(s: string): string[] | null {
  const out: string[] = [];
  const max = Math.max(...[...VALID_CONSONANTS].map((c) => c.length));
  for (let i = 0; i < s.length; ) {
    let hit: string | null = null;
    for (let len = max; len >= 1; len--) {
      const cand = s.slice(i, i + len);
      if (cand.length === len && VALID_CONSONANTS.has(cand)) { hit = cand; break; }
    }
    if (hit === null) return null;
    out.push(hit);
    i += hit.length;
  }
  return out.length >= 2 ? out : null;
}

// cluster-onset:<s> 的合法取值：取自 syllables.ts 的 LEGAL_ONSETS，并做同样的形近字符规整——
// LEGAL_ONSETS 里 gl/gr/gw/gj 四项源码里写的是 ASCII "g"，而 extractTags 实际吐出的是
// phones.ts 里 G 对应的 IPA script-g "ɡ"，两者字面不相等；规整后才能既正确接受真正会被
// extractTags 产出的 "ɡl" 这类值，又正确拒绝 ASCII "gl" 这种永远不会被产出的误写。
const VALID_ONSETS = new Set([...LEGAL_ONSETS].map(withLookalikesReplaced));

/**
 * 笔记正文里那两节硬性的有没有写。
 *
 * ── 为什么值得一条校验 ──
 *
 * 笔记模板原来把六段并列，还写着「`notes/` 里现有两篇就是范例」。而那两篇
 * （kl-cluster、l-vs-n，都是 7-28 加的）恰恰是**唯一不照模板写的两篇**：
 * kl-cluster 缺「自检法」和「对比训练」，后者更是一个 minimal pair 都没有。
 * **照着「看范例」做的人，产出的就是不合模板的笔记**——而没有任何东西会红。
 *
 * 只查这两节，不查另外四段：
 *   · **自检法**——读者能自己验证对错的动作。没有它，笔记就退回成"多听多练"，
 *     而这个仓库存在的前提正是**你不知道自己念得对不对**。
 *   · **对比训练**——minimal pairs，先中文后英文。没有可对照的一对词，
 *     "哪里不一样"就只能靠感觉。
 * 其余四段是建议：讲词的笔记（`words:`）本来就不该套「音标与定位」那一套，
 * 硬查只会逼出一节废话。
 *
 * **认小节标题，不认正文里散着的一句话**：kl-cluster 当初全文最后一行就有
 * 「自检：如果你能把 clean 和"克林"区分开」，可读者在"我到底做对没有"的时候
 * 回头翻不到它。
 */
export function validateShape(notes: Note[]): string[] {
  const REQUIRED = [
    { what: '自检法', re: /^#+ .*自检/m, why: '读者没法自己验证做对没有，笔记就退回成"多听多练"' },
    { what: '对比训练', re: /^#+ .*(对比|minimal)/im, why: '没有可对照的一对词，"哪里不一样"就只能靠感觉' },
  ];
  const warnings: string[] = [];
  for (const note of notes) {
    for (const r of REQUIRED) {
      if (!r.re.test(note.markdown)) {
        warnings.push(
          `[notes] 笔记 "${note.id}"（${note.file}）没有「${r.what}」这一节——${r.why}。见 AGENTS.md 的「笔记模板」`,
        );
      }
    }
    for (const s of 对读者的实测断言(note.markdown)) {
      warnings.push(
        `[notes] 笔记 "${note.id}"（${note.file}）在正文里对读者作实测断言：「${s}」`
        + '——那是写笔记那个人的数，不是读这篇的人的。见 AGENTS.md 的「severity 是派生的」',
      );
    }
  }
  return warnings;
}

/**
 * 笔记正文里断言"你有这个毛病"。
 *
 * severity 那次改的是**标签**——界面上不再显示「已确认的短板」，改由服务端按使用者
 * 自己的评测记录换档。但笔记正文里的判决一直留着：「/n/ 是**你**最大的一个问题，
 * 没有第二」「误区一（**你**正在犯的）」「**你**自己踩过的那两个」。别人克隆下来读到的
 * 是上一个使用者的诊断书，而措辞是第二人称——对他就是句假话，跟当初那个 severity
 * 一模一样。
 *
 * **只认两种机械形状**，不假装能认出所有写法：
 *   1. 同一句里既有「你」又有实测次数（`N 次` / `N%`）
 *   2. 「你」当了「犯 / 踩」的主语
 * 规矩本身写在 AGENTS.md，这里只拦最常见、最容易手滑的那两种。
 *
 * 数字那一条**只认 次/%**，不认所有数字：「把弱读音节拖长 2 秒，听你拖出来的是什么」
 * 是正当的自检法，按"你+数字"去拦会把它误伤掉。
 */
function 对读者的实测断言(markdown: string): string[] {
  const out: string[] = [];
  for (const s of markdown.split(/[\n。！？]/)) {
    if (!s.includes('你')) continue;
    if (/(\d+\s*次|\d+\s*%)/.test(s) || /你[^\n]{0,12}(犯|踩)/.test(s)) out.push(s.trim());
  }
  return out;
}

/**
 * 校验每篇笔记的 triggers 是否都是 extractTags（server/src/analysis/features.ts）实际可能
 * 产生的标签。返回人类可读的告警文案，不抛出、不修改传入的 notes——由调用方（NoteStore.load）
 * 决定如何处理（目前是 console.warn，笔记本身仍然照常加载，不会被跳过）。
 */
export function validateTriggers(notes: Note[]): string[] {
  const warnings: string[] = [];
  for (const note of notes) {
    for (const trigger of note.triggers) {
      if (STATIC_TRIGGERS.has(trigger)) continue;

      const phonemeMatch = trigger.match(/^phoneme:(.+)$/);
      if (phonemeMatch) {
        const ipa = phonemeMatch[1];
        if (VALID_PHONEMES.has(ipa)) continue;
        const suggestion = withLookalikesReplaced(ipa);
        const hint = suggestion !== ipa && VALID_PHONEMES.has(suggestion)
          ? `，是否想用 "phoneme:${suggestion}"？`
          : '';
        warnings.push(
          `[notes] 笔记 "${note.id}" 的 trigger "${trigger}" 不是 extractTags 可能产生的音素${hint}`,
        );
        continue;
      }

      // cluster-coda 没法照 onset 那样用白名单校验：onset 有 LEGAL_ONSETS（音节切分要靠它
      // 决定中间那串辅音怎么分），而 coda 是"剩下的辅音全归它"，本来就没有合法表。
      // 能查的只有一件事：串里每个符号都得是真实存在的**辅音**音素。
      // 这已经足够挡住实际会犯的错——形近字符（ASCII g / IPA ɡ）和把元音写进 coda。
      const codaMatch = trigger.match(/^cluster-coda:(.+)$/);
      if (codaMatch) {
        const coda = codaMatch[1];
        if (splitConsonants(coda) !== null) continue;
        const suggestion = withLookalikesReplaced(coda);
        const hint = suggestion !== coda && splitConsonants(suggestion) !== null
          ? `，是否想用 "cluster-coda:${suggestion}"？`
          : '';
        warnings.push(
          `[notes] 笔记 "${note.id}" 的 trigger "${trigger}" 不是由辅音音素组成的 coda 连缀${hint}`,
        );
        continue;
      }

      const clusterMatch = trigger.match(/^cluster-onset:(.+)$/);
      if (clusterMatch) {
        const onset = clusterMatch[1];
        if (VALID_ONSETS.has(onset)) continue;
        const suggestion = withLookalikesReplaced(onset);
        const hint = suggestion !== onset && VALID_ONSETS.has(suggestion)
          ? `，是否想用 "cluster-onset:${suggestion}"？`
          : '';
        warnings.push(
          `[notes] 笔记 "${note.id}" 的 trigger "${trigger}" 不是合法的 onset 连缀，extractTags 永远不会产生它${hint}`,
        );
        continue;
      }

      // 后半句**从 STATIC_TRIGGERS 生成**，不手抄。原来是写死的
      // 「也不是 clear-l/dark-l/flap-t」——往 Set 里加第四个标签而忘了改这句，
      // 报错信息就开始说谎：它会说 final-voiced 不合法，而它其实合法。
      warnings.push(
        `[notes] 笔记 "${note.id}" 的 trigger "${trigger}" 不是已知的 trigger 格式`
        + `（既不是 phoneme:/cluster-onset:/cluster-coda:，也不是 ${[...STATIC_TRIGGERS].join('/')}）`,
      );
    }

    // contrasts 也得校验，而且**理由比 triggers 更强**：坏 trigger 至少还会让笔记
    // 在词条页上少出现一次，比较容易被察觉；坏 contrasts 只影响"报错时谁来讲"，
    // 表现是**该出现的那一次没出现**——正是这个仓库刚栽过的那种坏法。
    // 形近字符的坑一模一样（ASCII g / IPA ɡ）：contrasts 写 `g` 就永远匹配不上。
    for (const ipa of note.contrasts) {
      if (VALID_PHONEMES.has(ipa)) continue;
      const suggestion = withLookalikesReplaced(ipa);
      const hint = suggestion !== ipa && VALID_PHONEMES.has(suggestion)
        ? `，是否想用 "${suggestion}"？`
        : '';
      warnings.push(
        `[notes] 笔记 "${note.id}" 的 contrasts "${ipa}" 不是本项目的音素${hint}`
        + '（contrasts 只写 IPA 符号本身，不带 phoneme: 前缀）',
      );
    }
  }
  return warnings;
}

export class NoteStore {
  private notes = new Map<string, Note>();
  private watcher: FSWatcher | undefined;
  /**
   * 上一次成功重扫产生的全部告警。console.warn 只有人盯着终端才看得见，而写笔记的
   * 往往是 AI——它够不到服务端控制台，够得到的只有 HTTP。/api/stats 原样带上这份，
   * 写完笔记（chokidar 自动重扫）再 GET 一次就能自查，不用「回头看一眼服务端日志」。
   */
  warnings: string[] = [];
  private warn(msg: string): void { console.warn(msg); this.warnings.push(msg); }

  constructor(private roots: NoteRoot[]) {}

  /** 三根的目录，按优先级从低到高。测试与启动日志要用 */
  get dirs(): string[] { return this.roots.map((r) => r.dir); }

  load(): void {
    // 随附根读不到说明安装坏了：保持上一次的结果，别把本机笔记一起清空。
    // legacy / local 不存在是正常状态（没选旧文件夹、本机还没写过），跳过即可。
    // 先把三根扫进一个临时 Map 再整体替换：扫到一半失败时内存里仍是上一份完整数据。
    const next = new Map<string, Note>();
    const warnings: string[] = [];
    // id -> 声明了这个 id 的所有文件（含来自哪一根）
    const seen = new Map<string, Array<{ file: string; source: NoteSource }>>();

    for (const root of this.roots) {
      let files: string[];
      try {
        files = readdirSync(root.dir).filter((f) => f.endsWith('.md'));
      } catch (e) {
        if (root.source === 'shipped') {
          console.warn(`[notes] 读不到随附笔记目录 ${root.dir}（${(e as Error).message}），本次跳过重扫，保持上一次加载的结果`);
          return;
        }
        continue;
      }

      for (const file of files) {
        try {
          const { data, content } = matter(readFileSync(join(root.dir, file), 'utf8'));
          // triggers 和 words 都可以缺省（缺省即空数组），但**至少要有一个非空**，
          // 否则这篇笔记永远匹配不上任何词条——文件躺在 notes/ 里却从不出现，最难查的那种。
          const rawTriggers = Array.isArray(data.triggers) ? data.triggers : [];
          const rawWords = Array.isArray(data.words) ? data.words : [];
          if (!data.id || !data.title) {
            warnings.push(`[notes] 跳过（frontmatter 缺 id 或 title）: ${file}`);
            continue;
          }
          if (rawTriggers.length === 0 && rawWords.length === 0) {
            warnings.push(`[notes] ${file}：triggers 和 words 都是空的，这篇笔记永远匹配不上任何词条。讲音的写 triggers，讲词的写 words。`);
          }
          const id = String(data.id);
          next.set(id, {
            id,
            title: String(data.title),
            triggers: rawTriggers.map(String),
            contrasts: (Array.isArray(data.contrasts) ? data.contrasts : []).map(String),
            // 词一律小写：词条 key 是小写的（app.ts 里 text.trim().toLowerCase()），
            // 笔记里手写成 Dopamine Detox 也该能对上
            words: rawWords.map((w: unknown) => String(w).trim().toLowerCase()).filter(Boolean),
            // 一律 'info'。**故意不读 frontmatter 里的 severity**：
            // 那是写笔记的人对读者的断言，而每个人的短板不一样。
            // 服务这一层会按使用者自己的记录把它换成 confirmed / watch（profile.ts 的 severityOf）。
            severity: 'info',
            markdown: content.trim(),
            file,
            source: root.source,
          });
          seen.set(id, [...(seen.get(id) ?? []), { file, source: root.source }]);
        } catch (e) {
          warnings.push(`[notes] 解析失败: ${file}（${(e as Error)?.message ?? e}）`);
        }
      }
    }

    this.notes = next;
    // 先清空再由 this.warn 逐条补回来：这样每条告警既进 warnings 数组、也真的
    // console.warn 出去。扫描时只收集不打印，是为了等整轮扫完再决定赢家。
    this.warnings = [];
    for (const warning of warnings) this.warn(warning);
    for (const [id, entries] of seen) {
      if (entries.length < 2) continue;
      const winner = this.notes.get(id)!;
      const ignored = entries.filter((e) => !(e.file === winner.file && e.source === winner.source));
      this.warn(
        `[notes] id 冲突：id "${id}" 被 ${entries.length} 篇笔记声明——当前生效的是 "${winner.file}"（${winner.source} 根），` +
        `${ignored.map((e) => `${e.source} 根的 "${e.file}"`).join('、')} 会被完全忽略` +
        `（优先级 shipped < legacy < local，高优先级胜出）。给多余的那几篇换个唯一 id`,
      );
    }
    for (const warning of [...validateTriggers(this.all()), ...validateShape(this.all())]) {
      this.warn(warning);
    }
  }

  all(): Note[] { return [...this.notes.values()]; }
  get(id: string): Note | undefined { return this.notes.get(id); }

  /**
   * @param onReload 每次重扫成功后回调。用来把"笔记变了"传出去——发音档案里
   *   「有没有笔记」和「该补的笔记」都依赖笔记集合，写完一篇不同步的话，
   *   档案会一直停在"这个音还没有笔记"，直到你下次录音才改过来。
   */
  watch(onReload?: () => void): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.dirs, { ignoreInitial: true }).on('all', () => {
      this.load();
      // 回调抛出去就是未捕获异常——chokidar 的事件处理器里崩掉会把整个服务带走。
      // 同步档案失败不该有这个后果。
      try { onReload?.(); } catch (e) { console.warn('[notes] 重扫后的回调出错', e); }
    });
  }
}
