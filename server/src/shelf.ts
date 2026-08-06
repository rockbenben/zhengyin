import { PLACES, phonemeClass, type PlaceId } from './analysis/articulation.js';

/**
 * 素材库怎么摆 —— 一篇笔记落在哪一格「书架」上。
 *
 * ── 为什么要有这个 ──
 *
 * 「素材库」是**共享的资料**，跟你是谁无关（跟它并排的「录音里反复出现」才是关于你的，
 * 判据是你自己的证据）。资料的职责是**被翻到**，不是被推荐。而它现在是一条平铺列表：
 * 17 篇时还能扫完，笔记攒到几十篇就没有入口了——想找「讲 θ 的那篇」只能从头看。
 *
 * ── 分类不是新发明的，是 triggers 本来就长这样 ──
 *
 * 仓库里 17 篇实际数据落进四个桶，没有一篇跨类：
 *   讲词的 2（words: 且没有音素 trigger）· 位置与连缀 5（结构标签 / cluster-*）
 *   辅音 6 · 元音 4
 * 所以这里只是把已经存在的形状读出来，没有往笔记上加新字段。
 *
 * ── 辅音为什么再按部位排 ──
 *
 * 复用 `/phonemes` 和统计页音位格同一条轴（PLACES 是唇→喉）。排完之后
 * l-n、n-ŋ、r 三篇齿龈的自动挨在一起——那正是音位格想让人看见的事
 * （「几个看起来不同的毛病其实是同一个部位」），在资料架上白得一次。
 */
export type Shelf = 'consonant' | 'vowel' | 'structure' | 'word';

/** 书架顺序：先按音（辅音→元音），再是位置与连缀，最后是讲具体词的 */
const SHELF_ORDER: Record<Shelf, number> = { consonant: 0, vowel: 1, structure: 2, word: 3 };

export interface Shelved {
  shelf: Shelf;
  /** 辅音架上再按部位分小段；其余为 null */
  place: PlaceId | null;
  /** 部位的中文名，界面直接用，不让前端再查一次表 */
  placeLabel: string | null;
}

interface NoteShape { triggers: string[]; words: string[] }

/** trigger 里的音素，按声明顺序 */
function phonemesOf(n: NoteShape): string[] {
  return n.triggers.filter((t) => t.startsWith('phoneme:')).map((t) => t.slice(8));
}

export function shelfOf(n: NoteShape): Shelved {
  const phones = phonemesOf(n);

  // 一个音素 trigger 都没有：要么讲词，要么讲结构（暗 L、闪音 T、连缀…）
  if (phones.length === 0) {
    const shelf: Shelf = n.triggers.length === 0 && n.words.length > 0 ? 'word' : 'structure';
    return { shelf, place: null, placeLabel: null };
  }

  // 混着声明辅音和元音的笔记现在一篇都没有。真出现时**按第一个 trigger 归类**——
  // 那是写笔记的人先想到的那个音，比"哪类多"更接近他的本意，而且规则是确定的。
  const first = phonemeClass(phones[0]);
  if (first === 'vowel') return { shelf: 'vowel', place: null, placeLabel: null };

  // 部位取这几个辅音里**最靠前**的（唇→喉）。n-ŋ 覆盖齿龈和软腭，摆在齿龈那段：
  // 跟同样在齿龈的 l-n 挨着，比丢到软腭去更有用。
  let best: number | null = null;
  for (const p of phones) {
    const i = PLACES.findIndex((pl) => pl.id === placeOfConsonant(p));
    if (i >= 0 && (best === null || i < best)) best = i;
  }
  if (best === null) return { shelf: 'consonant', place: null, placeLabel: null };
  return { shelf: 'consonant', place: PLACES[best].id, placeLabel: PLACES[best].label };
}

/**
 * 素材库左边那一列路标：这篇管的是什么。
 *
 * 音素笔记给 IPA 符号本身——**用户认的是 /θ/，不是「齿间擦音」四个字**，
 * 而这一列的活是让眼睛扫着找，不是读。结构和讲词的笔记没有符号可给，
 * 退回它们自己的说法（连缀串、词）。标签翻成人话由前端的 explainTag 负责，
 * 那份表已经存在、还有测试盯着它盖全，不在这儿抄第二份。
 */
export function coversOf(n: NoteShape): string[] {
  const phones = phonemesOf(n);
  if (phones.length > 0) return phones;
  if (n.triggers.length > 0) return n.triggers;
  return n.words;
}

/** 比较两篇笔记在素材库里的先后 */
export function compareShelf(a: Shelved & { title: string }, b: Shelved & { title: string }): number {
  const s = SHELF_ORDER[a.shelf] - SHELF_ORDER[b.shelf];
  if (s !== 0) return s;
  const pa = a.place ? PLACES.findIndex((p) => p.id === a.place) : -1;
  const pb = b.place ? PLACES.findIndex((p) => p.id === b.place) : -1;
  if (pa !== pb) return pa - pb;
  return a.title.localeCompare(b.title, 'zh');
}

// ── 部位查表 ────────────────────────────────────────────────────────────
// articulation.ts 没有导出"单个音素的部位"这个查询，只导出整张表。
// 在这儿建一次索引，别让调用方每篇笔记都去 filter 一遍全表。
import { articulationTable } from './analysis/articulation.js';

let PLACE_OF: Map<string, PlaceId> | null = null;
function placeOfConsonant(ipa: string): PlaceId | null {
  if (!PLACE_OF) {
    PLACE_OF = new Map();
    for (const a of articulationTable()) {
      if (a.kind === 'consonant') PLACE_OF.set(a.ipa, a.place as PlaceId);
    }
  }
  return PLACE_OF.get(ipa) ?? null;
}
