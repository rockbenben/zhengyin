import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Space, Typography } from 'antd';
import Notice from '../components/Notice';
import { LoadFailed } from '../components/PageResult';
import { Link } from 'react-router';
import { api, isOffline } from '../api';
import { describeError as describe } from '../lib/notation';
import Offline from '../components/Offline';
import type { StatsResult, ArticulationTable, Articulation } from '../types';

/**
 * 发音统计 —— 音位格。
 *
 * 用 IPA 辅音表当主体，而不是列一张排行榜：横轴是发音部位（舌头碰在哪儿），纵轴是发音
 * 方式（气流怎么走）。你的错误打成颜色落在格子上，于是能看出**列**上的规律——
 * "四个看起来不同的毛病其实是同一个部位的问题"，这句话列表说不出来。
 *
 * 部位归属来自服务端的发音部位表；这一页只负责画和数，不做音系推导。
 */

const HEAT = (n: number, max: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));

export default function StatsPage() {
  useTitle('发音统计');
  const [data, setData] = useState<StatsResult | null>(null);
  const [art, setArt] = useState<ArticulationTable | null>(null);
  const [err, setErr] = useState<null | 'offline' | 'failed'>(null);

  useEffect(() => {
    Promise.all([api.stats(), api.articulation()])
      .then(([s, a]) => { setData(s); setArt(a); })
      .catch((e) => setErr(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  // 连不上就给那块说得清怎么办的屏；服务在跑只是这次失败，才是刷新能救的。
  //
  // 用 LoadFailed，别在这儿自己拼一遍。原来这里是一个 Notice，正文跟 LoadFailed
  // 一字不差地抄了一份，而**它没有刷新按钮**——话里让人「刷新一下」，手边一个可点的
  // 都没有。同一句话在两个文件里各写一份，还各带一套不同的动作，正是这么来的。
  if (err === 'offline') return <Offline />;
  if (err) return <LoadFailed what="统计" />;
  if (!data || !art) return null;

  // stuck 是后加的字段：旧的桩/旧响应里可能没有，按空数组降级，别让整页崩
  const { overall, phonemes, stuck = [] } = data;

  if (overall.attempts === 0) {
    return (
      <Space direction="vertical" size={24} style={{ width: '100%' }}>
        <Head overall={overall} />
        {/* 不用 antd 的 Empty：它不传 image 就会画自带的那张空盒子插画，而这套
            视觉里没有插画（理由跟 PageResult 换掉 Result、Notice 换掉 Alert 是同一条）。
            Notice 的 quiet 档就是一条中性细线，正合空状态——它既不是提示也不是警告。 */}
        <Notice tone="quiet">
          还没有评测记录。在<Link to="/">首页</Link>或<Link to="/review">复习页</Link>录一次音就会开始积累。
        </Notice>
      </Space>
    );
  }

  // 每个音素被判错了多少次（目标侧和听到侧都算——把 /n/ 发成 /l/ 是这两个音之间的问题）
  const count = new Map<string, number>();
  for (const p of phonemes) {
    for (const ipa of [p.targetIpa, p.heardIpa]) {
      if (ipa) count.set(ipa, (count.get(ipa) ?? 0) + p.count);
    }
  }
  const max = Math.max(1, ...count.values());

  const consonants = art.phones.filter((p): p is Extract<Articulation, { kind: 'consonant' }> => p.kind === 'consonant');
  const manners = Object.keys(art.manners);
  const cell = (place: string, manner: string) =>
    consonants.filter((c) => c.place === place && c.manner === manner);

  // 每个部位上错了多少次 —— 用来找出"错误集中在哪一列"
  const byPlace = art.places.map((pl) => ({
    ...pl,
    n: consonants.filter((c) => c.place === pl.id).reduce((s, c) => s + (count.get(c.ipa) ?? 0), 0),
  }));
  const totalPlaced = byPlace.reduce((s, p) => s + p.n, 0);
  const top = [...byPlace].sort((a, b) => b.n - a.n)[0];
  // 只有真的集中才说"集中"。过半才算，否则如实说分散。
  const concentrated = totalPlaced > 0 && top.n / totalPlaced > 0.5 ? top : null;

  // 判据在服务端（profile.ts 的 worthANote），这里只挑出它标好的
  const missing = phonemes.filter((r) => r.worthANote);

  return (
    <Space direction="vertical" size={30} style={{ width: '100%' }}>
      <Head overall={overall} headline={
        concentrated
          ? <>你的错误集中在<span style={{ color: 'var(--blue)' }}>{concentrated.label}</span></>
          : <>错误分布在多个发音部位</>
      } />

      <section>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', alignItems: 'baseline', marginBottom: 12 }}>
          <span className="slug">横轴 舌头碰在哪儿　纵轴 气流怎么走</span>
          {/* 说「越浓」不说「越深」：格子是把蓝往纸上兑（styles.css 的 data-heat，
              12%→30%→55%→100%），**深浅要看是哪套纸**——浅色纸上兑得越多越深，
              深色纸上兑得越多反而越亮。实测深色模式下错得最多的那格是全表最浅的一块，
              而图例正说着「颜色越深」。浓度在两套纸上都是同一个方向。 */}
          <span className="slug" style={{ marginLeft: 'auto', letterSpacing: '.1em' }}>
            颜色越浓 错得越多
          </span>
        </div>
        <div className="grid-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th />
                {art.places.map((pl) => (
                  <th key={pl.id} scope="col" data-column-hit={concentrated?.id === pl.id ? '1' : undefined}>
                    {pl.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {manners.map((m) => (
                <tr key={m}>
                  <th scope="row">{art.manners[m]}</th>
                  {art.places.map((pl) => {
                    const cs = cell(pl.id, m);
                    const n = cs.reduce((s, c) => s + (count.get(c.ipa) ?? 0), 0);
                    return (
                      <td key={pl.id} data-heat={HEAT(n, max)}>
                        {n > 0 && <span className="grid-count">{n}</span>}
                        <span className="grid-cell ipa">
                          {cs.length > 0 ? cs.map((c) => c.ipa).join(' ') : '·'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 卡住的词 ──
             摆在「最常犯的错」**前面**是有意的：音素统计回答"我哪个音不行"，
             这一块回答"我今天该练什么"。对只用网页、没有 AI 讲解的人，
             后者才是能立刻动手的那个。数据早就算了，一直只写进发音档案那个 md 文件。 */}
      {stuck.length > 0 && (
        <section>
          <span className="slug">卡住的词 · 练了 5 次以上、还是过不去</span>
          <div style={{ marginTop: 10 }}>
            {stuck.map((w) => (
              <div
                key={w.text}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0',
                  borderTop: '1px solid var(--rule)', flexWrap: 'wrap',
                }}
              >
                <Link to={`/word/${encodeURIComponent(w.text)}`} style={{ fontSize: 15 }}>{w.text}</Link>
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--quiet)' }}>
                  练了 {w.attempts} 次 · 全对 {w.clean} 次
                  <span style={{ marginLeft: 10, color: 'var(--blue)' }}>
                    {Math.round((w.clean / w.attempts) * 100)}%
                  </span>
                </span>
              </div>
            ))}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 10 }}>
            点进去再录几次。还是过不去的话，把这个词发给 AI——
            {'多半是某个音的动作没找对，那需要一篇讲解，不是多练几遍能解决的。'}
          </Typography.Text>
        </section>
      )}

      <section>
        <span className="slug">最常犯的错</span>
        <div style={{ marginTop: 10 }}>
          {phonemes.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0',
                borderTop: '1px solid var(--rule)', flexWrap: 'wrap',
              }}
            >
              <span className="mono" style={{ minWidth: 26, color: 'var(--blue)', fontWeight: 700 }}>{r.count}</span>
              <span style={{ fontSize: 14.5 }}>{describe(r)}</span>
              {/* ── 条目之间要有**分隔符**，不能只靠间距 ──
                     词条名本身可以含空格（"dopamine detox"、"prompt prefix"），只留 8px
                     的话三个等距的词读成一个短语：实测这一行显示成
                     `dopamine detox coffee`，而它其实是**两个词条**。
                     笔记标题那列更糟，两个长句直接连成一句。
                     用 · 分隔，跟这个文件下面那条 Notice 里 `　·　` 是同一个记号。 */}
              <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--quiet)' }}>
                {r.words.slice(0, 4).map((w, wi) => (
                  <span key={w}>
                    {wi > 0 && <span style={{ margin: '0 7px', color: 'var(--rule)' }}>·</span>}
                    <Link to={`/word/${encodeURIComponent(w)}`}>{w}</Link>
                  </span>
                ))}
              </span>
              {/* 讲解这一列要**自己报出名字**。
                     词条和讲解都是蓝链接、同一个字号，紧挨着排就分不出边界——
                     实测这一行读成了 `thin  l / n 不分（边音 vs 鼻音）`，
                     像是 thin 这个词后面跟了串什么东西。加一个 slug 标签，
                     跟没有笔记时那个「该补一篇」在同一个位置上，两种状态就对称了。 */}
              {r.notes.length > 0 ? (
                /* **标题不走等宽。** 这一格里两样东西性质不同：「讲解」是标注（slug 自带等宽），
                   而笔记标题是一句中文（「弱读音节要塌下去——machine 不是「马-婶」」）。
                   等宽字体没有中文字形，整句会掉进回退字体、按等宽的字距排——
                   全页最该读的那个链接反而成了最难读的一行。词条名留在等宽里是对的：
                   那是数据，而且要靠等宽把「dopamine detox」这种带空格的名字排稳。 */
                <span style={{ fontSize: 12.5, marginLeft: 14, display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                  <span className="slug" style={{ letterSpacing: '.1em' }}>讲解</span>
                  <span>
                    {r.notes.map((n, ni) => (
                      <span key={n.id}>
                        {ni > 0 && <span style={{ margin: '0 7px', color: 'var(--rule)' }}>·</span>}
                        <Link to={`/notes/${n.id}`}>{n.title}</Link>
                      </span>
                    ))}
                  </span>
                </span>
              ) : r.worthANote ? (
                /* **只标够格的**。原来凡是没笔记就打一个琥珀色的框，
                   于是十几行里排下来一整列告警——包括那些只出现过一次、
                   只在一个词上出现过的（那种更可能是那次录音的问题，不是发音习惯）。
                   标常态会把真正该看的那两条淹掉。 */
                <span
                  className="mono"
                  style={{
                    fontSize: 11.5, letterSpacing: '.06em', marginLeft: 8, padding: '2px 7px',
                    border: '1px solid var(--amber)', color: 'var(--amber)', whiteSpace: 'nowrap',
                  }}
                >该补一篇</span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {missing.length > 0 && (
        <Notice tone="warn" label={`该补 ${missing.length} 篇`} title="这几个音反复出错，而且不止在一个词上，但还没有笔记">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {/* 不写 notes/：那是仓库里的目录名、开发者的叫法，界面里它叫「发音笔记」 */}
            <span>把它们告诉 AI，它会写成一篇<Link to="/notes">发音笔记</Link>——写完之后评测报错时会直接给出「该怎么改」。</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {missing.map((r) => `${describe(r)} × ${r.count}`).join('　·　')}
            </span>
          </Space>
        </Notice>
      )}

      <Typography.Text type="secondary" className="measure" style={{ fontSize: 12.5 }}>
        这些数字只反映音素层面对没对上。音色、时长、重音测不了——那部分靠 A/B 对比自己听。
        {'同一份统计也写在 '}<code>{'data/users/<当前用户>/发音档案.md'}</code>{' 里。'}
      </Typography.Text>
    </Space>
  );
}

// describe 搬去了 lib/notation.ts —— 首页那块「卡住的地方」也要说出是哪个音，
// 两边必须是同一个实现。抄一份的下场这个仓库见过：worthANote 曾经档案说 2 条、这一页说 14 条。

function Head({ overall, headline }: { overall: StatsResult['overall']; headline?: React.ReactNode }) {
  const pct = overall.attempts > 0 ? Math.round((overall.clean / overall.attempts) * 100) : 0;
  return (
    <header className="word-head" style={{ paddingTop: 6 }}>
      <span className="reg-mark" aria-hidden="true"><i /></span>
      <div>
        <h1 className="display" style={{ fontSize: 'clamp(30px, 5vw, 46px)', textWrap: 'balance' }}>
          {headline ?? '发音统计'}
        </h1>
        <p className="mono" style={{ margin: '14px 0 0', fontSize: 13, color: 'var(--quiet)' }}>
          {overall.attempts} 次评测 · {overall.words} 个词 · {overall.clean} 次全对（{pct}%）
          {overall.firstAt && ` · ${overall.firstAt.slice(0, 10)} 起`}
        </p>
      </div>
    </header>
  );
}
