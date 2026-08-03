import { api } from '../api';
import type { ArticulationTable, Articulation } from '../types';

/**
 * 发音部位表的取用与缓存。整站一次请求，音素条和部位尺共用。
 *
 * 表本身由服务端出（server/src/analysis/articulation.ts）——音系知识只在那一处，
 * 前端只负责画和查。
 */
let cache: Promise<ArticulationTable> | null = null;

export function articulationTable(): Promise<ArticulationTable> {
  if (!cache) {
    cache = api.articulation();
    // 失败不缓存坏结果，下次还能重试
    cache.catch(() => { cache = null; });
  }
  return cache;
}

export function findPhone(table: ArticulationTable, ipa: string): Articulation | null {
  return table.phones.find((p) => p.ipa === ipa) ?? null;
}

/** 一句话说清这个音的类别，如「齿 · 擦音 · 清音」。表里查不到就返回 null */
export function describePhone(table: ArticulationTable, a: Articulation): string | null {
  if (a.kind === 'consonant') {
    const place = table.places.find((p) => p.id === a.place)?.label ?? a.place;
    const manner = table.manners[a.manner] ?? a.manner;
    return [place, manner, a.voiced ? '浊音' : '清音', a.nasal ? '走鼻腔' : null]
      .filter(Boolean).join(' · ');
  }
  const height = a.height > 0.7 ? '高' : a.height > 0.35 ? '中' : '低';
  const back = a.back > 0.65 ? '后' : a.back > 0.35 ? '央' : '前';
  return [`${back}${height}元音`, a.rounded ? '圆唇' : '展唇', a.glideTo ? '双元音' : null]
    .filter(Boolean).join(' · ');
}
