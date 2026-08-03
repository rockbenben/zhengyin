import { useEffect, useState } from 'react';
import { Typography } from 'antd';
import type { ArticulationTable, Articulation } from '../types';
import { articulationTable, findPhone } from '../lib/articulation';
import { phonemic, phonetic } from '../lib/notation';

/**
 * 发音部位尺 / 元音四边形 —— 回答"身体上哪一步做错了"。
 *
 * 只说"你把 /n/ 发成了 /l/"是不够的：真正要紧的是这两个音**差在哪一步**。
 * /n/ 和 /l/ 舌尖位置完全相同，只差软腭——所以正确的话是"舌尖没错，错在软腭"，
 * 而不是"舌头位置不对"。后者会把人往错的方向练。
 *
 * 这个判断由服务端的发音部位表（analysis/articulation.ts）算出来，这里只画：
 * 辅音画一维部位尺（唇→声门），元音画 IPA 元音四边形。
 * 黑标记 = 目标，蓝空心标记 = 你发的，跟套印带同一套油墨逻辑。
 *
 * 表里查不到的音素（模型偶尔吐的别的语言的音）一律不画，也不猜。
 */

/** 两个音差在哪一步——这句话是这个组件存在的理由 */
function difference(t: Articulation, h: Articulation): string | null {
  if (t.kind !== h.kind) return null;
  if (t.kind === 'consonant' && h.kind === 'consonant') {
    if (t.place === h.place && t.nasal !== h.nasal) {
      return t.nasal
        ? '舌位一样，差在软腭：目标音要让软腭降下来、气流走鼻腔，你把它抬着封住了鼻腔。'
        : '舌位一样，差在软腭：目标音要抬起软腭封住鼻腔，你让气流跑进鼻子了。';
    }
    if (t.place === h.place && t.manner !== h.manner) {
      return '舌头碰的位置是对的，差在气流怎么走——抵住之后放开的方式不一样。';
    }
    if (t.place !== h.place) return '舌头碰的位置就不一样，得先把接触点挪对。';
    if (t.voiced !== h.voiced) {
      return t.voiced ? '位置和方式都对，差在声带没有振动。' : '位置和方式都对，但声带多振动了。';
    }
  }
  if (t.kind === 'vowel' && h.kind === 'vowel') {
    const dh = t.height - h.height;
    const db = t.back - h.back;
    if (Math.abs(dh) >= Math.abs(db) && Math.abs(dh) > .08) {
      return dh > 0 ? '舌位要再抬高一点。' : '舌位要再放低一点。';
    }
    if (Math.abs(db) > .08) return db > 0 ? '舌头要再往后一点。' : '舌头要再往前一点。';
  }
  return null;
}

/** 目标音该怎么发。始终显示——"那我到底该怎么做"是发错之后的第一个问题 */
function HowTo({ ipa, text }: { ipa: string; text: string }) {
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--rule)', paddingTop: 14 }}>
      <span className="slug">{phonemic(ipa)} 怎么发</span>
      <Typography.Paragraph style={{ margin: '6px 0 0', maxWidth: '58ch', lineHeight: 1.9 }}>
        {text}
      </Typography.Paragraph>
    </div>
  );
}

export default function PlaceRuler({ targetIpa, heardIpa }: { targetIpa: string; heardIpa: string }) {
  const [data, setData] = useState<ArticulationTable | null>(null);
  useEffect(() => { articulationTable().then(setData).catch(() => {}); }, []);
  if (!data) return null;

  const t = findPhone(data, targetIpa);
  const h = findPhone(data, heardIpa);
  // 表里查不到就不画。硬画一个位置等于编造诊断。
  if (!t || !h || t.kind !== h.kind) return null;

  const note = difference(t, h);

  if (t.kind === 'consonant' && h.kind === 'consonant') {
    const n = data.places.length;
    const at = (id: string) => {
      const i = data.places.findIndex((p) => p.id === id);
      return ((i + 0.5) / n) * 100;
    };
    const same = t.place === h.place;
    return (
      <div className="ruler">
        <span className="slug">舌头碰在哪儿</span>
        <div className="ruler-track">
          {data.places.map((p, i) => (
            <span key={p.id} className="ruler-tick" style={{ left: `${(i / n) * 100}%` }} />
          ))}
          <span className="ruler-tick" style={{ left: '100%' }} />

          {/* 位置相同时两个标记会完全重叠，那本身就是结论——所以把蓝的挪开一点点，
              让"重合"仍然看得出是两个标记而不是一个 */}
          <span className="ruler-pin" data-plate="black" style={{ left: `${at(t.place)}%` }} />
          <span className="ruler-label" data-plate="black" style={{ left: `${at(t.place)}%` }}>
            {data.places.find((p) => p.id === t.place)?.label} {phonemic(t.ipa)}
          </span>
          {!same && (
            <>
              <span className="ruler-pin" data-plate="blue" style={{ left: `${at(h.place)}%` }} />
              <span className="ruler-label" data-plate="blue" style={{ left: `${at(h.place)}%` }}>
                {data.places.find((p) => p.id === h.place)?.label} {phonetic(h.ipa)}
              </span>
            </>
          )}
          {same && (
            <span className="ruler-label" data-plate="blue" style={{ left: `${at(t.place)}%` }}>
              {phonetic(h.ipa)} 也在这儿
            </span>
          )}
        </div>
        <Manner t={t} h={h} manners={data.manners} />
        {note && <Typography.Paragraph style={{ margin: '14px 0 0', maxWidth: '58ch' }}>{note}</Typography.Paragraph>}
        {t.howTo && <HowTo ipa={t.ipa} text={t.howTo} />}
      </div>
    );
  }

  if (t.kind === 'vowel' && h.kind === 'vowel') {
    // IPA 元音四边形：左上=前高、右上=后高、左下=前低、右下=后低。
    // 梯形而非矩形是因为口腔在低元音处前后活动范围本来就窄，这是 IPA 的标准画法。
    const xy = (v: { height: number; back: number }) => {
      const y = 100 - v.height * 100;
      const inset = (1 - v.height) * 14;          // 越低越窄
      return { x: inset + v.back * (100 - inset * 2), y };
    };
    const pt = xy(t); const ph = xy(h);
    return (
      <div className="ruler">
        <span className="slug">舌位</span>
        <div className="quad" style={{ marginTop: 12 }}>
          <svg viewBox="-8 -8 116 116" aria-label={`元音四边形：目标 /${t.ipa}/ 与你发的 /${h.ipa}/`}>
            <polygon points="0,0 100,0 86,100 14,100" fill="none"
              stroke="var(--rule)" strokeWidth="1.2" />
            <text x="-4" y="-2" fontSize="6" fill="var(--quiet)" fontFamily="var(--font-mono)">前</text>
            <text x="92" y="-2" fontSize="6" fill="var(--quiet)" fontFamily="var(--font-mono)">后</text>
            <text x="-6" y="4" fontSize="6" fill="var(--quiet)" fontFamily="var(--font-mono)"
              transform="rotate(-90 -6 4)">高</text>
            <line x1={pt.x} y1={pt.y} x2={ph.x} y2={ph.y} stroke="var(--blue)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={pt.x} cy={pt.y} r="4.5" fill="var(--black)" />
            <text x={pt.x} y={pt.y - 7} fontSize="7" textAnchor="middle" fill="var(--black)"
              fontFamily="var(--font-ipa)">{t.ipa}</text>
            <circle cx={ph.x} cy={ph.y} r="4.5" fill="var(--paper)" stroke="var(--blue)" strokeWidth="2.4" />
            <text x={ph.x} y={ph.y + 13} fontSize="7" textAnchor="middle" fill="var(--blue)"
              fontFamily="var(--font-ipa)">{h.ipa}</text>
          </svg>
        </div>
        {note && <Typography.Paragraph style={{ margin: '12px 0 0', maxWidth: '58ch' }}>{note}</Typography.Paragraph>}
        {t.howTo && <HowTo ipa={t.ipa} text={t.howTo} />}
      </div>
    );
  }
  return null;
}

function Manner({ t, h, manners }: {
  t: Articulation; h: Articulation; manners: Record<string, string>;
}) {
  if (t.kind !== 'consonant' || h.kind !== 'consonant') return null;
  const chip = (label: string, plate: 'black' | 'blue', on: boolean) => (
    <span
      className="mono"
      style={{
        fontSize: 11, letterSpacing: '.06em', padding: '3px 7px',
        border: `1px solid ${plate === 'black' ? 'var(--black)' : 'var(--blue)'}`,
        color: plate === 'black' ? 'var(--black)' : 'var(--blue)',
        opacity: on ? 1 : .35,
      }}
    >{label}</span>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'center', marginTop: 34 }}>
      <span className="slug" style={{ letterSpacing: '.14em' }}>气流</span>
      {chip(manners[t.manner] ?? t.manner, 'black', true)}
      {t.manner !== h.manner && chip(manners[h.manner] ?? h.manner, 'blue', true)}
      <span className="slug" style={{ letterSpacing: '.14em', marginLeft: 8 }}>鼻腔</span>
      {chip(t.nasal ? '开' : '闭', 'black', true)}
      {t.nasal !== h.nasal && chip(h.nasal ? '开' : '闭', 'blue', true)}
    </div>
  );
}
