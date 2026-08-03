import { IPA, parsePhones } from './phones.js';

// 每个音素的发音部位与方式。给前端的「发音部位尺」和「元音四边形」提供坐标。
//
// 为什么放服务端：这是音系学知识，跟 phones.ts 的 IPA 表、features.ts 的标签同属一类。
// 客户端不该也不再自己实现一份音系规则（Task 15 定下的原则）——前端拿到这张表只负责画，
// 不做任何推导。
//
// 这张表的用途很具体：评测报"你把 /n/ 发成了 /l/"之后，得能指出**身体上哪一步做错了**。
// 而 /n/ 和 /l/ 的 place 完全相同、只差 nasal —— 这正是那篇笔记讲的"舌尖没错，错在软腭"。
// 有了这张表，界面能自己得出这个结论，不用为每一对音手写一句话。

/** 发音部位，从唇到声门，数组顺序即前后顺序（尺子的刻度） */
export const PLACES = [
  { id: 'bilabial', label: '双唇' },
  { id: 'labiodental', label: '唇齿' },
  { id: 'dental', label: '齿' },
  { id: 'alveolar', label: '齿龈' },
  { id: 'postalveolar', label: '龈后' },
  { id: 'palatal', label: '硬腭' },
  { id: 'velar', label: '软腭' },
  { id: 'glottal', label: '声门' },
] as const;

export type PlaceId = typeof PLACES[number]['id'];

export const MANNERS = {
  stop: '塞音', nasal: '鼻音', fricative: '擦音', affricate: '塞擦音',
  lateral: '边音', approximant: '近音',
} as const;

export type MannerId = keyof typeof MANNERS;

export interface Consonant {
  kind: 'consonant';
  ipa: string;
  place: PlaceId;
  manner: MannerId;
  voiced: boolean;
  /** 软腭下降、气流走鼻腔。这是 /n/ 与 /l/ 唯一的差别 */
  nasal: boolean;
}

/**
 * 元音位置：舌位高度与前后，即 IPA 元音四边形的坐标。
 * 都归一到 0–1，前端直接当百分比用，不用再换算。
 * - height 0 = 最低（æ ɑ），1 = 最高（i u）
 * - back   0 = 最前（i æ），1 = 最后（u ɑ）
 */
export interface Vowel {
  kind: 'vowel';
  ipa: string;
  height: number;
  back: number;
  rounded: boolean;
  /** 双元音的落点；单元音为 null。有它才画得出滑动方向 */
  glideTo: { height: number; back: number } | null;
}

export type Articulation = Consonant | Vowel;

const C = (ipa: string, place: PlaceId, manner: MannerId, voiced: boolean, nasal = false): Consonant =>
  ({ kind: 'consonant', ipa, place, manner, voiced, nasal });

const V = (ipa: string, height: number, back: number, rounded = false,
  glideTo: Vowel['glideTo'] = null): Vowel =>
  ({ kind: 'vowel', ipa, height, back, rounded, glideTo });

const TABLE: Articulation[] = [
  // ── 辅音 ──
  C('p', 'bilabial', 'stop', false),      C('b', 'bilabial', 'stop', true),
  C('m', 'bilabial', 'nasal', true, true), C('w', 'bilabial', 'approximant', true),
  C('f', 'labiodental', 'fricative', false), C('v', 'labiodental', 'fricative', true),
  C('θ', 'dental', 'fricative', false),   C('ð', 'dental', 'fricative', true),
  C('t', 'alveolar', 'stop', false),      C('d', 'alveolar', 'stop', true),
  C('n', 'alveolar', 'nasal', true, true),
  C('s', 'alveolar', 'fricative', false), C('z', 'alveolar', 'fricative', true),
  C('l', 'alveolar', 'lateral', true),    C('r', 'alveolar', 'approximant', true),
  C('ʃ', 'postalveolar', 'fricative', false), C('ʒ', 'postalveolar', 'fricative', true),
  C('tʃ', 'postalveolar', 'affricate', false), C('dʒ', 'postalveolar', 'affricate', true),
  C('j', 'palatal', 'approximant', true),
  C('k', 'velar', 'stop', false),         C('ɡ', 'velar', 'stop', true),
  C('ŋ', 'velar', 'nasal', true, true),
  C('h', 'glottal', 'fricative', false),

  // ── 元音（四边形坐标） ──
  V('i', 1.00, 0.00),   V('ɪ', 0.82, 0.14),
  V('ɛ', 0.50, 0.12),   V('æ', 0.18, 0.08),
  V('ə', 0.50, 0.50),   V('ʌ', 0.44, 0.58),
  V('ɝ', 0.52, 0.52),   V('ɚ', 0.50, 0.52),
  V('u', 1.00, 1.00, true), V('ʊ', 0.80, 0.84, true),
  V('ɔ', 0.44, 0.94, true), V('ɑ', 0.06, 0.86),
  // 双元音：起点是主体，glideTo 是落点
  V('eɪ', 0.62, 0.10, false, { height: 0.82, back: 0.14 }),
  V('oʊ', 0.62, 0.92, true,  { height: 0.80, back: 0.84 }),
  V('aɪ', 0.10, 0.40, false, { height: 0.82, back: 0.14 }),
  V('aʊ', 0.10, 0.40, false, { height: 0.80, back: 0.84 }),
  V('ɔɪ', 0.44, 0.94, true,  { height: 0.82, back: 0.14 }),
];


/**
 * 每个音素**具体怎么发**——落到可执行的身体动作：舌尖顶哪里、气流从哪走、嘴唇展还是圆。
 * 写法遵照 CLAUDE.md 的风格约束：不堆音系学理论，给的是马上能照做的东西。
 *
 * ── 内容的出处 ──
 * 动作描述不是自己编的，对照的是标准教材里公认的教法：部位/方式框架按
 * Ladefoged《A Course in Phonetics》和 Gimson《Pronunciation of English》；
 * 面向学习者的对比操练参考 Prator & Robinett《Manual of American English
 * Pronunciation》；意象化的口诀（如 r 的"低吼"、z 的"蜜蜂嗡嗡"）取自
 * Ann Cook《American Accent Training》（中译《美语发音13秘诀》）一系的教学传统；
 * 拼音/汉字锚点是赖世雄音标教程那一路中文教材的通行做法。
 * **拼音锚点只当起点用**：哪里跟英语不一样，当场点明，绝不写成"就等于"。
 * 中文母语者的干扰点（拼音 z 是塞擦音、sh 卷舌、b/d/g 其实不带声等）都是
 * 二语习得文献里反复记载的，不是猜测。
 *
 * 跟 notes/ 的分工：
 * - 这张表是**音素本身**的客观发音方式，全集覆盖，跟是谁在念无关
 * - notes/ 是**这个人的问题**（l/n 不分、辅音连缀加塞元音），有针对性、有自检法和对比训练
 *
 * 所以评测报错时，即使还没有对应的笔记，也至少答得出"那这个音该怎么发"——
 * 在这张表之前，那种情况下界面只能说"还没有笔记"，等于什么都没给。
 */
const HOW_TO: Record<string, string> = {
  // ── 辅音 ──
  p: '双唇闭紧憋住气，突然放开。跟中文“怕”的开头一样，手放嘴前能感到一股气。',
  b: '口型跟 /p/ 一样，但放开时喉咙要震。中文“爸”的开头喉咙不震，那是 /p/ 不是 /b/。',
  m: '双唇闭紧一直不放开，声音全走鼻子。跟中文“摸”的开头一样。',
  w: '嘴唇撮圆突出，像要吹蜡烛，然后立刻滑向后面的元音。跟中文“蛙”的开头一样。',
  f: '上门牙轻搭在下唇内侧，气从缝里擦出去。跟中文“夫”的开头一样。',
  v: '上门牙搭住下唇（/f/ 的口型），喉咙震着擦出去。最常见错法是念成 /w/——对镜子查：牙齿必须碰着下唇，嘴唇不许撮圆。very 不是 wery。',
  θ: '舌尖伸出来抵住上门牙下缘，对镜子看得见舌尖，气从舌齿间擦出去。缩回去就成了 /s/。',
  ð: '位置跟 /θ/ 一样，加上喉咙震动。this、that 的开头。',
  t: '舌尖抵住上齿龈憋住气，突然放开。跟中文“他”的开头一样。',
  d: '位置跟 /t/ 一样，但放开时喉咙要震。中文“大”的开头喉咙不震，那是 /t/。',
  n: '舌尖抵住上齿龈一直不放开，声音全走鼻子。捏住鼻子就发不出声——发得出来说明你发的是 /l/。',
  s: '舌尖靠近上齿龈但不碰到，留条窄缝让气擦过去。跟中文“丝”的开头一样。',
  z: '先拖长 /s/，中途把喉咙震起来（手摸喉结确认），像蜜蜂嗡嗡。拼音 z（“字”）其实是 /ts/，不是它。',
  l: '舌尖顶住上齿龈，舌头两侧塌下来让气从两边流出去。捏住鼻子声音不变——变了说明你发的是 /n/。',
  r: '舌尖翘起悬空，不碰任何东西、没有摩擦声，嘴唇略撮圆。先拖长“儿——”保持舌头别动，那就是它的音色。中文“日”带摩擦，太紧，不是它。',
  ʃ: '舌面前部抬向上颚（比 /s/ 靠后），嘴唇往前撅一点。拼音 sh（“诗”）卷得太靠后，拼音 x（“西”）太靠前还咧着嘴——she 在两者中间。',
  ʒ: '位置跟 /ʃ/ 一样，加上喉咙震动。measure、vision 中间那个音。',
  tʃ: '先像 /t/ 堵住气，放开的瞬间直接进 /ʃ/——两步连成一个音，嘴唇略撅。拼音 ch（“吃”）太卷、q（“七”）太靠前，都不是它。',
  dʒ: '动作跟 /tʃ/ 一样，全程喉咙震。别拿拼音 j（“鸡”）顶替——太靠前还咧嘴，这个要撅唇。just、age。',
  j: '舌面抬向上颚，然后立刻滑向后面的元音。跟中文“呀”的开头一样。',
  k: '舌根顶住软腭憋住气，突然放开。跟中文“卡”的开头一样。',
  ɡ: '位置跟 /k/ 一样，但放开时喉咙要震。中文“高”的开头喉咙不震，那是 /k/。',
  ŋ: '舌根顶住软腭不放开，声音全走鼻子。就是中文“昂”的收尾，后面别再多加 /ɡ/。',
  h: '口型直接按后面那个元音摆好，只送气不出声。别用中文“喝”那个擦音，太靠后了。',

  // ── 元音 ──
  i: '就是中文的“衣”，但要更长、嘴角向两侧拉得更开。see、bee。',
  ɪ: '不是短版“衣”：嘴角彻底放松（别咧），舌头降一点，落在“衣”和“诶”之间，短促带过。sit 不是 seat。',
  ɛ: '嘴张开一半，舌位靠前。中文“诶”的起头，但停住别往上滑。bed、west。',
  æ: '先摆“诶”的口型，再把下巴多掉一档、嘴角继续向两边拉——嘴是横着宽的。不刻意撑就会缩回 /ɛ/。cat、bad。',
  ɑ: '医生检查喉咙的那个“啊”：下巴掉到能竖放两根手指，嘴是上下开的椭圆，舌头后缩放平。father、hot。',
  ɔ: '舌位比 /ɑ/ 略高，嘴唇收成松松的圆。很多美国人它已并进 /ɑ/（cot=caught），听不出区别不是你的问题。thought。',
  ʌ: '“啊”的懒人版：嘴只开一半、哪里都不用力，短促地哼出来——像被轻捶了一下肚子发出的那一声。cup、love。',
  ə: '最放松的那个音，嘴唇舌头都不使劲，只出现在轻读音节。about 的开头。',
  ɚ: '轻读的 r 音：舌头放松，尾巴带一点卷。butter、father 的结尾。',
  ɝ: '就是普通话“儿、二”的音色，但要拖住不放：从头卷到尾，别中途滑回“呃”。bird、church。',
  ʊ: '不是短版“乌”：嘴唇松松拢一点（别用力撮圆），落在“乌”和“喔”之间，短促带过。book 不是 boot。',
  u: '嘴唇用力撮圆突出，比中文“乌”更圆更长。boot、blue。',
  eɪ: '从“欸”滑到“衣”，嘴角始终略拉开。起点是“欸”不是“啊”。day、name。',
  oʊ: '从圆唇的“欧”起步，嘴唇边滑边收紧到接近“乌”——两步，滑完才算。停在半路就成了 /ɔ/。go、no。',
  aɪ: '就是中文的“爱”，从“啊”滑到“衣”。night、fine。',
  aʊ: '就是中文的“奥”，从“啊”滑到“乌”，嘴唇跟着收圆。how、now。',
  ɔɪ: '从圆唇的“哦”滑到“衣”，嘴唇由圆变展。boy、voice。',
};

/** 这个音怎么发。表里没有就返回 null——不编。 */
export function howToPronounce(ipa: string): string | null {
  return HOW_TO[ipa] ?? null;
}

const BY_IPA = new Map(TABLE.map((a) => [a.ipa, a]));

/**
 * 这个音是元音还是辅音。**表里没有就返回 null**——模型偶尔吐出归一化认不出的符号
 * （实测见过裸 `o`），那时候没有判据，不要硬归一类。
 *
 * 用途在 diff.ts 的对齐代价：跨类替换（"把 /n/ 发成了 /i/"）几乎都是对齐没对齐上，
 * 不是真的发音错法。
 */
export function phonemeClass(ipa: string): 'vowel' | 'consonant' | null {
  return BY_IPA.get(ipa)?.kind ?? null;
}

/**
 * 浊**阻塞音**（塞音 / 擦音 / 塞擦音）：b d ɡ v ð z ʒ dʒ。
 *
 * features.ts 的 `final-voiced` 标签靠它。**判据放这儿不放那儿**：清浊和发音方式
 * 是这张表的知识，抄一份到 features.ts 就是两处维护，而这个仓库在
 * 「同一个判据两份实现」上已经栽过好几次。
 *
 * 为什么只有阻塞音：清化发生在阻塞音上（bed→bet、dog→dock）；
 * 浊的鼻音和流音（m n ŋ l r w j）本来就没有这个问题，标了等于给每个以 n 结尾的词
 * 挂一篇不相干的笔记。
 */
export function isVoicedObstruent(ipa: string): boolean {
  const a = BY_IPA.get(ipa);
  return a?.kind === 'consonant' && a.voiced
    && (a.manner === 'stop' || a.manner === 'fricative' || a.manner === 'affricate');
}

export function articulationTable(): Array<Articulation & { howTo: string | null }> {
  return TABLE.map((a) => ({ ...a, howTo: HOW_TO[a.ipa] ?? null }));
}

/** 有位置数据但还没写"怎么发"的音素。跟 missingFromTable 一样在启动时报出来 */
export function missingHowTo(): string[] {
  return TABLE.filter((a) => !HOW_TO[a.ipa]).map((a) => a.ipa).sort();
}

/**
 * 本项目的音素全集（parsePhones 实际会产出的那些）里，还没进这张表的。
 * 服务启动时报警：漏一个音素，界面上那个音的部位尺就悄悄不画了——不报错、不崩，
 * 只是永远空着。notes.ts 的 validateTriggers 是同一个思路。
 */
export function missingFromTable(): string[] {
  const all = new Set(
    parsePhones(Object.keys(IPA).flatMap((b) => [0, 1, 2].map((s) => `${b}${s}`))).map((p) => p.ipa),
  );
  return [...all].filter((ipa) => !BY_IPA.has(ipa)).sort();
}
