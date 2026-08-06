import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Space } from 'antd';
import type { WordAnalysis, ArticulationTable } from '../types';
import { articulationTable, findPhone, describePhone } from '../lib/articulation';

interface Props {
  word: WordAnalysis;
  /** 该词条命中的全部笔记 trigger 标签的并集（entry.notes 里所有 matched 的并集） */
  hitTags: Set<string>;
  /** 点击命中笔记的音素时回调，传回触发命中的那个具体 tag。用于滚动到那篇笔记 */
  onTagClick: (tag: string) => void;
}

// 音素条：一个词拆成一排铅字，每格一个音素，字面就是 IPA。
//
// **每个音素都点得开**，点开就说这个音具体怎么发（舌尖顶哪、气流走哪、唇形）。
// 原来只有命中笔记的那几格可点、且只会滚到笔记去——于是"这个音怎么发"这份数据
// 只在录音发错之后才露面，词条页上翻来翻去什么都问不到。
//
// 命中笔记的音素额外用蓝版标出（跟套印带同一套油墨），不用红色：那说的是"这个音有笔记
// 可看"，不是"你错了"。
//
// 逐音素的 IPA/tag 归属完全来自服务端的 word.phoneIpa / word.phoneTags（server/src/
// analysis/features.ts 的 attributeTags()）——前端不重算任何音系规则。
/**
 * 这一节读多重。1 主重音、2 次重音、0 轻读；越界（不该发生）返回 null，不画。
 *
 * **不能把"没读到"填成轻读**：dopamine 是 1-0-2，词尾 -mine 是次重音、元音满的
 * /miːn/，默认成轻读就是在屏幕上说假话。宁可不画。
 */
function levelOf(word: WordAnalysis, gi: number): 0 | 1 | 2 | null {
  const s = word.syllableStress[gi];
  return s === 0 || s === 1 || s === 2 ? s : null;
}

/**
 * 重音图形：● 重 / ● 次重 / ○ 轻。
 *
 * 换掉的是「重音 / 第 2 节」那套。「第 2 节」是**序号不是属性**——它告诉你在哪儿，
 * 不告诉你要做什么；而三音节词会排成「第 1 节 · 重音 · 第 3 节」，两个非重读音节
 * 明明同一类却写着两种字。**真正该被命名的是"轻"**：使用者最大的元音问题就是
 * 弱读音节念成满元音（ə→æ，跨 machine 和 dopamine），而那一节以前根本没有名字。
 *
 * 圆圈大小表示轻重，是英语教材里最通行的画法（Cambridge《English Pronunciation
 * in Use》、Ann Baker《Ship or Sheep》都用大小圈标 Ooo / oOo 这种节奏型），
 * 好处是把字母和音标都撇开、只剩节奏。这里保留中文字，是因为圆圈本身不自明；
 * 图形负责一眼扫到，字负责说准。
 */
function StressMark({ level }: { level: 0 | 1 | 2 | null }) {
  if (level === null) return null;
  const strong = level !== 0;
  return (
    <span
      data-stress={level}
      className="slug"
      style={{
        display: 'flex', alignItems: 'center', gap: 5, letterSpacing: '.1em',
        color: strong ? 'var(--black)' : 'var(--quiet)',
        fontWeight: level === 1 ? 700 : 400,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: level === 1 ? 9 : level === 2 ? 7 : 5,
          height: level === 1 ? 9 : level === 2 ? 7 : 5,
          borderRadius: '50%',
          // 实心=读实，空心=弱化。次重音也是实心：它的元音是满的，跟轻读不是一类
          background: strong ? 'var(--black)' : 'transparent',
          border: strong ? 'none' : '1px solid var(--quiet)',
        }}
      />
      {level === 1 ? '重' : level === 2 ? '次重' : '轻'}
    </span>
  );
}

export default function PhonemeBar({ word, hitTags, onTagClick }: Props) {
  const { arpabet, phoneIpa, phoneTags, syllables } = word;
  const [table, setTable] = useState<ArticulationTable | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => { articulationTable().then(setTable).catch(() => {}); }, []);
  // 换词条时收起，免得停在上一个词的某个音素上
  useEffect(() => { setOpen(null); }, [word.word]);

  const openIpa = open !== null ? phoneIpa[open] : undefined;
  const phone = table && openIpa ? findPhone(table, openIpa) : null;

  // 按音节分组。词典查不到的词（found:false）这几个数组全是空的，
  // 退化成"一整节、零个格子"——下面的 cell() 因此一次都不会被调用。
  const groups = syllables.length > 0 ? syllables : [arpabet.map((_, i) => i)];

  const cell = (i: number) => {
          const ipa = phoneIpa[i];
          const causing = phoneTags[i].filter((t) => hitTags.has(t));
          const hit = causing.length > 0;
          const active = open === i;

          const body = (
            <span
              style={{
                display: 'grid', justifyItems: 'center', gap: 1,
                minWidth: 42, padding: '7px 9px 5px',
                border: `1px solid ${active ? 'var(--black)' : hit ? 'var(--blue)' : 'var(--rule)'}`,
                background: active ? 'var(--paper-deep)' : hit ? 'var(--blue-soft)' : 'transparent',
              }}
            >
              <span
                className="ipa"
                style={{ fontSize: 19, lineHeight: 1.1, color: hit && !active ? 'var(--blue)' : 'var(--black)' }}
              >
                {ipa ?? '·'}
              </span>
              {/* 这里原来还压一行 ARPAbet（TH / IH1 / N）。那是 CMUdict 的内部记法，
                  这个工具的使用者是学美音的中文母语者，不是语音学研究者——
                  而且 `IH1` 末尾那个数字是重音位，**这个工具明写着不评判重音**，
                  印一个自己声称测不了的维度出来是自相矛盾。
                  音本身上面那行 IPA 已经说了，点进去还有整页的「怎么发」。 */}
            </span>
          );

          return (
            <button
              key={i}
              type="button"
              aria-expanded={active}
              onClick={() => setOpen(active ? null : i)}
              style={{ padding: 0, border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }}
            >
              {body}
            </button>
          );
  };

  return (
    <div>
      {/* 按音节分组：页头的 /ˈdoʊpəˌmin/ 和这排格子这样才对得上，重音落在哪一节也看得见。
          重音是这套评测【测不了】的东西（模型不输出重音），所以更该在这里显式标出来。 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ display: 'grid', gap: 5, justifyItems: 'start' }}>
            <div style={{ display: 'flex', gap: 4 }}>{g.map((i) => cell(i))}</div>
            {groups.length > 1 && <StressMark level={levelOf(word, gi)} />}
          </div>
        ))}
      </div>

      {open === null ? (
        <span className="slug" style={{ display: 'block', marginTop: 9 }}>
          点音标看这个音怎么发
        </span>
      ) : (
        <div
          style={{
            marginTop: 10, borderLeft: '3px solid var(--black)', paddingLeft: 18,
            display: 'grid', gap: 8,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'baseline' }}>
            <span className="ipa" style={{ fontSize: 22 }}>/{openIpa}/</span>
            {table && phone && (
              <span className="slug" style={{ letterSpacing: '.1em' }}>{describePhone(table, phone)}</span>
            )}
          </div>

          {phone?.howTo ? (
            <p className="measure" style={{ margin: 0, fontSize: 14.5, lineHeight: 1.9 }}>{phone.howTo}</p>
          ) : (
            <p style={{ margin: 0, fontSize: 14, color: 'var(--quiet)' }}>
              {table ? '这个音还没写发音说明。' : '正在取发音说明…'}
            </p>
          )}

          {/* ── 两条出路，分清是"这个音"还是"这个词" ──
                 原来只有一条，写着「这个音有笔记，跳过去看」，跳的是**命中的笔记**。
                 而命中可以来自一篇讲词的笔记：dopamine 那篇声明了 phoneme:aɪ，于是点
                 light 的 aɪ 会跳到「dopamine 的词尾 /miːn/」，跟这个音毫无关系。
                 根因已经在数据层改掉（讲词的笔记改用 words），
                 但出路本身也得分开：**音素的归音素页，笔记只在真正讲这个音时才给。** */}
          <Space size={16} wrap>
            <Link
              to={`/phoneme/${encodeURIComponent(openIpa!)}`}
              className="mono"
              style={{ fontSize: 12.5 }}
            >
              这个音怎么发 · 例词 →
            </Link>
            {(() => {
              // 只认**讲这个音**的 trigger。word: 前缀那种是词范围的命中（matchNotes 打的标），
              // 不该出现在音素这一栏——那正是当初混在一起的东西。
              const causing = phoneTags[open].filter((t) => hitTags.has(t));
              if (causing.length === 0) return null;
              return (
                <button
                  type="button"
                  onClick={() => onTagClick(causing[0])}
                  className="mono"
                  style={{
                    padding: 0, border: 0, background: 'none',
                    color: 'var(--blue)', cursor: 'pointer', fontSize: 12.5,
                  }}
                >
                  你在这个音上的笔记 →
                </button>
              );
            })()}
          </Space>
        </div>
      )}
    </div>
  );
}
