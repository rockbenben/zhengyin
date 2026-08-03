import { IPA, parsePhones } from './phones.js';

// 把音素识别边车（asr-service）吐出的原始 eSpeak IPA 归一化到本项目的 IPA 集合。
//
// 为什么需要这一层：边车用的 wav2vec2 模型是**多语种**的，词表里有中文声调、日语音、
// 长音符这些本项目 phones.ts 的 IPA 表根本没有的东西。不归一化的话，`ɑː` 跟 `ɑ` 对不上，
// 明明念对了也会被判成"发错了"。
//
// 这张表里的每一条都对得上 spike 的**实测输出**（选型 spike 里那 35 个真人录音
// 跑出来的结果），不是照着 IPA 手册抄的。加新条目时也请照这个规矩：
// 先拿真实音频跑出来，看见了再加。

/**
 * 本项目认的 IPA 全集，归一化的目标。
 *
 * **不能**直接拿 Object.values(IPA)：parsePhones() 在查完 IPA 表之后还按重音做了改写
 * （AH0→ə、ER0→ɚ、ER1/2→ɝ），那两个音素在 IPA 表的值域里根本不存在。漏掉它们的后果是
 * 把 water 的词尾 ɚ 当成"未知符号"硬映射成 ɝ，于是念对了也报"发错了"。
 * notes.ts 的 VALID_PHONEMES 踩过同一个坑，这里用同样的办法：把每个 ARPAbet key 配上
 * 0/1/2 三种重音真跑一遍 parsePhones，拿它实际吐出的值当全集。
 */
const KNOWN = new Set(
  parsePhones(Object.keys(IPA).flatMap((b) => [0, 1, 2].map((st) => `${b}${st}`))).map((p) => p.ipa),
);

/**
 * 重音变体归并：模型**不输出重音**，所以 ə/ʌ、ɚ/ɝ 这种纯粹由重音区分的对立，它给不出
 * 判据。硬报成"你把 ɚ 发成了 ɝ"是在断言输入里根本没有的信息——water 念得完全正确也会
 * 中招（实测过）。对齐前把两边都归并掉，这个维度就一律不评判。
 *
 * 注意这**不是**在放宽标准：重音本身确实重要，只是这条技术路径测不了它，
 * 假装能测比不测更糟。
 */
export function collapseStress(phones: string[]): string[] {
  return phones.map((p) => (p === 'ə' ? 'ʌ' : p === 'ɚ' ? 'ɝ' : p));
}

// 多字符的先匹配（`aɪ` 不能被拆成 `a` + `ɪ`），所以按长度降序排。
const MAP: Record<string, string | string[]> = {
  // —— 长音符：本项目的 IPA 表里没有长短对立，一律去掉 ——
  // 实测来源：father → `f ɑː ð ɚ`、blue → `b l uː`、water → `w ɑː ɾ ɚ`
  'ɑː': 'ɑ', 'uː': 'u', 'iː': 'i', 'ɔː': 'ɔ', 'ɛː': 'ɛ', 'æː': 'æ',
  'ɪː': 'ɪ', 'ʊː': 'ʊ', 'oː': 'oʊ', 'ɐː': 'ʌ',

  // —— r 化元音 → ɝ ——
  // 实测：bird → `b ɜː d`、church → `tʃ ɜː tʃ`、butter → `b ʌ ɾ ɚ`、measure → `m ɛ ʒ ɚ`
  // ɚ 和 ə 本身就在 KNOWN 里（parsePhones 对 ER0/AH0 就产出它们），不在这里映射
  'ɜː': 'ɝ', 'ɜ': 'ɝ', 'əː': 'ɝ',

  // —— r 化元音 + r：拆成"元音 + r"，本项目没有这种合体音素 ——
  'ɑːɹ': ['ɑ', 'r'], 'ɔːɹ': ['ɔ', 'r'], 'oːɹ': ['oʊ', 'r'],
  'ɛɹ': ['ɛ', 'r'], 'ɪɹ': ['ɪ', 'r'], 'ʊɹ': ['ʊ', 'r'],

  // —— 辅音 ——
  // 实测：red → `ɹ ɛ d`。eSpeak 用 ɹ 表示英语的 r，本项目 IPA 表里 R 是 'r'。
  'ɹ': 'r', 'ɻ': 'r',
  // 实测：butter → `b ʌ ɾ ɚ`、water → `w ɑː ɾ ɚ`。闪音 T 在美音里**就是对的**读法，
  // 归到 t 才不会把念对的 water 判成发错。（想单独提示闪音的话靠 flap-t tag，不靠这里。）
  'ɾ': 't',
  'ɫ': 'l',                       // 暗 L 仍然是 /l/

  // —— 元音 ——
  // 实测：boy → `b oɪ`、voice → `v oɪ s`。eSpeak 的 oɪ 就是本项目的 ɔɪ。
  'oɪ': 'ɔɪ',
  'əʊ': 'oʊ',                     // 英式写法的 GOAT，归到美式 oʊ
  'ʉ': 'u',                       // 实测：zoo → `z ʉ`
  'ɐ': 'ʌ',                       // eSpeak 的 STRUT 常写 ɐ（这 35 个样本里没出现过，按 eSpeak 文档归到 ʌ）
  'ᵻ': 'ɪ',                       // eSpeak 的弱化 barred-i
  // 实测：this → `d e s`、cat → `k eː t`。day → `eɪ` 说明模型要表示 FACE 时会直接写
  // eɪ，所以裸 e / eː 不是 FACE，归到 ɛ。
  'e': 'ɛ', 'eː': 'ɛ',
  // 实测：book → `b a k`、cup → `k a`。IPA 的 a 是**前**开元音，比 ɑ 更靠近 æ。
  'a': 'æ',
  'ɒ': 'ɑ', 'ɑ̃': 'ɑ', 'ø': 'ɝ', 'œ': 'ɝ',
};

/** 识别出来了、但本项目没有对应音素的符号：丢弃，不硬凑一个看着像的 */
const DROP = new Set(['ʔ']);

// 切分用的候选符号，按长度降序——`aɪ` 必须先于 `a` 被匹配到，否则会被切成 a + ɪ。
const KEYS = [...Object.keys(MAP), ...KNOWN]
  .filter((k) => !DROP.has(k))
  .sort((a, b) => b.length - a.length);

/** 一个已知符号 → 本项目 IPA。调用前须确保 sym 在 KEYS 或 DROP 里。 */
function expand(sym: string): string[] {
  if (DROP.has(sym)) return [];
  if (KNOWN.has(sym)) return [sym];
  const m = MAP[sym];
  return Array.isArray(m) ? m : [m];
}

/**
 * 一个 eSpeak token → 0 个或多个本项目 IPA 音素。
 * 认不出来的原样返回：宁可让它在对齐结果里显示成一个陌生符号，也不要悄悄映射成某个
 * 看着像的音——那会把"模型听到了别的东西"伪装成"你发错了这个特定的音"。
 */
export function normalizeToken(token: string): string[] {
  // 多语种模型的声调数字（实测：see → `s i5`，那个 5 是中文声调标记）、重音符、
  // 以及**音节分隔符 `.`**，都不属于音素本身，先剥掉。
  //
  // `.` 是后补的：实测边车吐过 `i. t ɛ i`，于是 `i.` 被当成一个音素一路带下去——
  // 它匹配不上任何 trigger（`phoneme:i.` 不存在）、在套印带上显示成一个怪字形、
  // 还会作为一个独立"音素"进统计。剥掉之后它就是正常的 `i`。
  // 同理连接符 `‿`：espeak 用它标连读，也不是音素。
  const t = token.replace(/[0-9]+$/, '').replace(/[ˈˌ.‿]/g, '');
  if (!t) return [];
  if (DROP.has(t) || KNOWN.has(t) || MAP[t] !== undefined) return expand(t);

  // 整体认不出来：按已知符号从左往右贪心切（模型偶尔吐 `aɪə`、`ɑːɹ` 这类组合 token）
  const out: string[] = [];
  let rest = t;
  while (rest.length > 0) {
    const key = KEYS.find((k) => rest.startsWith(k));
    if (!key) return [t];      // 切不动：原样保留，让它在结果里可见
    out.push(...expand(key));
    rest = rest.slice(key.length);
  }
  return out;
}

/**
 * 边车返回的整串 IPA（空格分隔的 token，如 `"n aɪ t"`）→ 本项目 IPA 音素数组。
 * 边车是哑服务，归一化这件事只在这里做一次。
 */
export function normalizeEspeakIpa(raw: string): string[] {
  return raw.trim().split(/\s+/).filter(Boolean).flatMap(normalizeToken);
}

/** 带置信度的一个音素 */
export interface ConfPhone { ipa: string; conf: number }

/**
 * 边车的逐音素结果（带置信度）→ 本项目 IPA。
 *
 * 一个 token 可能展开成多个音素（`ɑːɹ` → ɑ + r），这时两个音素**共用同一个置信度**：
 * 模型给的是那一段音频的把握程度，拆开之后没有更细的依据，硬编一个差值等于凭空造数。
 */
export function normalizeEspeakPhones(phones: ConfPhone[]): ConfPhone[] {
  return phones.flatMap((p) => normalizeToken(p.ipa).map((ipa) => ({ ipa, conf: p.conf })));
}

/**
 * 低于这个置信度的"错"，只当成"模型拿不准"，不计入统计、UI 上也不标红。
 *
 * 0.5 这个数来自选型 spike 的实测：真检出
 * 普遍在 0.76 以上（night 的 n=1.00、light 的 l=0.96），而已知的几个误报都在 0.35 以下
 * （water 的 ɑː=0.31、cat 的 eː=0.33）。中间这段空档很宽，取 0.5。
 *
 * **样本只有几条**，这个数是拍在一个宽空档中间的，不是调出来的最优值。真实录音积累多了
 * 之后该回来重新看——误报还多就调高，漏报多就调低。
 *
 * ── 这个门槛的唯一归属地 ──
 *
 * 它曾经在前端有三份硬编码拷贝（ReviewPage / Recorder / OverprintStrip），外加
 * web/src/lib/align.test.ts（当时叫 noise.test.ts）里第四份——而那一份测的是测试文件
 * 自己复制的实现，真实现漂移了它照样绿。
 * 四份全靠注释"跟服务端一致"维系，改哪份都没有编译错。
 *
 * 现在的约定：**判定只在服务端做一次**，结果作为 sure 挂在每个 AlignOp 上
 * （见 app.ts 的 /api/pronounce）。前端一律读 op.sure，不许再跟 conf 比大小。
 * 其余地方谈到这件事时指回这里，不要再抄一遍缘由——注释的重复和代码的重复一样会漂移。
 *
 * 边界是**闭的**（>= CONFIDENT 算有把握），由 app.test.ts 里那条 mock `conf: CONFIDENT`
 * 的用例钉住——它引用常量而不是写死 0.5，所以重调这个值之后边界仍然被守着。
 * 反过来，这个值本身**不该**被测试钉死：上面那段就在邀请人按实测去重调它。
 */
export const CONFIDENT = 0.5;
