import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link } from 'react-router';
import { Space, Spin, Typography } from 'antd';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import { LoadFailed } from '../components/PageResult';
import type { PhonemeList } from '../types';

/**
 * 全部音素的索引：每个音素都有一页文档，点过去能看到含这个音的具体例词。
 *
 * 按辅音/元音分两栏，辅音再按发音部位分组（PLACES 的顺序就是从唇到喉，跟部位尺同一把尺）。
 * 每个音下面标两个数：库里有几个词含它、有几篇笔记在讲它。
 * **有笔记的音标出来**，因为那是"你在这个音上出过问题"的唯一凭据——
 * 但没笔记不是缺陷：41 个音都有「怎么发」，笔记只在念差了之后才写。
 */
export default function PhonemesPage() {
  useTitle('音素');
  const [d, setD] = useState<PhonemeList | null>(null);
  // 取失败原来是 setD(null)，跟"还没取回来"同一个状态，而下面又是 `if (!d) return null`
  // ——**服务没起来时这一页整个白屏**：没有转圈、没有一个字，点了侧栏的「音素」
  // 什么都不发生。空白不是状态，是"这个应用坏了"。
  const [error, setError] = useState<null | 'offline' | 'failed'>(null);
  // 「最该注意的六条」默认开还是收，看**录过音没有**。
  // null = 还没取回来；跟音素表一起等，免得先摊开再收起来闪一下。
  const [attempts, setAttempts] = useState<number | null>(null);

  useEffect(() => {
    api.phonemes().then(setD).catch((e) => setError(isOffline(e) ? 'offline' : 'failed'));
    api.stats().then((s) => setAttempts(s.overall.attempts)).catch(() => setAttempts(0));
  }, []);

  if (error === 'offline') return <Offline />;
  if (error) {
    return (
      <LoadFailed what="音素表" />
    );
  }
  if (!d || attempts === null) return <Spin style={{ marginTop: 48 }} />;

  const consonants = d.phones.filter((p) => p.kind === 'consonant');
  const vowels = d.phones.filter((p) => p.kind === 'vowel');

  /**
   * 一格里的一个音。
   *
   * **有笔记不写「有笔记」三个字**——格子里塞不下，改成加粗 + 底部一道蓝线。
   * 例词数跟在符号右上角，**挂在每个音自己身上，不按格子合计**：
   * 合计会把同时含 ə 和 ʌ 的词数两遍，那个数就成了假的
   * （统计页的音位格可以合计，因为它数的是错误事件，事件本来就该相加）。
   */
  const cell = (p: PhonemeList['phones'][number]) => (
    <Link
      key={p.ipa}
      to={`/phoneme/${encodeURIComponent(p.ipa)}`}
      title={`${p.ipa}${p.noteCount > 0 ? '　有笔记' : ''}${p.exampleCount > 0 ? `　库里 ${p.exampleCount} 个例词` : '　库里还没有例词'}`}
      style={{ color: 'var(--black)', whiteSpace: 'nowrap' }}
    >
      <span
        className="ipa"
        style={{
          fontSize: 18,
          fontWeight: p.noteCount > 0 ? 700 : 400,
          borderBottom: p.noteCount > 0 ? '2px solid var(--blue)' : '2px solid transparent',
        }}
      >
        {p.ipa}
      </span>
      {p.exampleCount > 0 && <sup className="phone-count">{p.exampleCount}</sup>}
    </Link>
  );

  /** 表格里的一格：可能空、可能一个音、也可能好几个（清浊成对时 t d 同格） */
  const box = (items: PhonemeList['phones'], key: string) => (
    <td key={key}>
      {items.length === 0
        ? <span className="grid-cell" style={{ color: 'var(--quiet)', opacity: 0.55 }}>·</span>
        : (
          <span
            className="grid-cell"
            style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '2px 10px' }}
          >
            {items.map(cell)}
          </span>
        )}
    </td>
  );

  return (
    <div>
      <header className="word-head" style={{ marginBottom: 24 }}>
        <span className="reg-mark" aria-hidden="true"><i /></span>
        <div>
          <span className="slug">音素表 · {d.phones.length} 个</span>
          <h1 className="display" style={{ marginTop: 8 }}>这些音各自怎么发</h1>
        </div>
      </header>

      <Typography.Paragraph className="measure" type="secondary">
        点进任意一个音，看它<strong>客观上怎么发</strong>（舌尖顶哪、气流走哪、唇形）
        {'以及库里含它的例词。这跟'}<Link to="/notes">笔记</Link>是两件事：
        {'这里跟谁在念无关，笔记讲的是'}<strong>你自己</strong>在某个音或某个词上的问题。
      </Typography.Paragraph>

      {/* 浏览 41 个音的人下一句话必然是"那我该重点注意哪几个"。
          按**影响听懂的程度**排，不按难度——前三条改了收益最大。
          完整版在 美音要点-中文母语者.md，这里只留能立刻行动的那几条。 */}
      {/* ── 录过音之后默认收起来 ──
          这六条是**长期有用的参考**，不像「怎么用」那样看过就没用了，所以不让它消失，
          只是收起来：老用户翻到这一页是来找某个音的，不该每次先滚过十行说明；
          新用户（还没录过音）照旧摊开——他正需要「那我该重点注意哪几个」。
          用原生 details 而不是 antd Collapse：这里要的就是一行摘要加一块内容，
          Collapse 会自带一层卡片边框，跟旁边这条蓝竖线打架。 */}
      <details
        open={attempts === 0}
        style={{ borderLeft: '3px solid var(--blue)', paddingLeft: 18, margin: '4px 0 8px' }}
      >
        <summary className="slug" style={{ color: 'var(--blue)', cursor: 'pointer' }}>
          中文母语者最该注意的
        </summary>
        <ol className="measure" style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 14, lineHeight: 2 }}>
          <li>
            <strong>音节结尾的辅音不许加元音</strong>——中文音节只能以元音 / n / ng 收尾，
            {'所以 '}<code>cat</code> 容易念成「凯特」、<code>desk</code> 念成「代斯」。
            {'数音节自检：这两个词都只有 '}<strong>1</strong> 个音节。
          </li>
          <li>
            <strong>长短元音是两个不同的音</strong>，不是长一点短一点：
            <Link to={`/phoneme/${encodeURIComponent('ɪ')}`}>ɪ</Link>{' / '}
            <Link to={`/phoneme/${encodeURIComponent('i')}`}>i</Link>（sit/seat）、
            <Link to={`/phoneme/${encodeURIComponent('ʊ')}`}>ʊ</Link>{' / '}
            <Link to={`/phoneme/${encodeURIComponent('u')}`}>u</Link>（book/boot）。
            {'看嘴角有没有拉开。'}
          </li>
          <li>
            <strong>中文里没有的四个辅音</strong>：
            <Link to={`/phoneme/${encodeURIComponent('θ')}`}>θ</Link>{'、'}
            <Link to={`/phoneme/${encodeURIComponent('ð')}`}>ð</Link>{'、'}
            <Link to={`/phoneme/${encodeURIComponent('v')}`}>v</Link>{'、'}
            <Link to={`/phoneme/${encodeURIComponent('r')}`}>r</Link>。
            {'前两个对镜子看得见舌尖才对。'}
          </li>
          <li>
            <strong>一个词只有一个重音</strong>，其余音节要轻到几乎听不见。
            {'手放下巴：整个词只该明显下沉一次。'}
          </li>
          <li>
            出现最多的元音 <Link to={`/phoneme/${encodeURIComponent('ə')}`}>ə</Link>{' '}
            的要点是<strong>越轻越对</strong>——中文没有「半个字」，本能会把它念成一个完整的字。
          </li>
          <li>
            <Link to={`/phoneme/${encodeURIComponent('l')}`}>l</Link> 和{' '}
            <Link to={`/phoneme/${encodeURIComponent('n')}`}>n</Link> 舌位完全一样，
            {'只差气流走两侧还是鼻腔。'}<strong>捏住鼻子</strong>：l 声音不变，n 发不出来。
          </li>
        </ol>
      </details>

      {/* ── 为什么是两张表，不是两排 chips ──
             原来按部位分组平铺，只给了**一根轴**（同一个部位的挨在一起），
             另一根——发音方式——丢了。而这批用户最该看见的一件事恰恰要两根轴才说得出来：
             /l/ 和 /n/ 在**同一列不同行**，舌尖位置一样，只差气流走两侧还是鼻腔。
             骨架跟统计页的音位格是同一张（.grid-table），学一次用两处；
             那边往格子里填的是你的错误热度，这里只是音本身，所以不上底色。 */}
      <Space direction="vertical" size={26} style={{ width: '100%', marginTop: 8 }}>
        <section>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', alignItems: 'baseline', marginBottom: 10 }}>
            <span className="slug">辅音 · {consonants.length} 个</span>
            <span className="slug" style={{ color: 'var(--quiet)' }}>
              横轴 舌头碰在哪儿　纵轴 气流怎么走
            </span>
            <span className="slug" style={{ marginLeft: 'auto', color: 'var(--quiet)' }}>
              加粗 · 有笔记　右上角小数字 · 库里有几个例词
            </span>
          </div>
          <div className="grid-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th />
                  {d.places.map((pl) => <th key={pl.id} scope="col">{pl.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.manners).map(([m, label]) => (
                  <tr key={m}>
                    <th scope="row">{label}</th>
                    {d.places.map((pl) => box(
                      consonants.filter((c) => c.place === pl.id && c.manner === m),
                      `${m}-${pl.id}`,
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section style={{ borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', alignItems: 'baseline', marginBottom: 10 }}>
            <span className="slug">元音 · {vowels.length} 个</span>
            <span className="slug" style={{ color: 'var(--quiet)' }}>
              横轴 舌头在前还是在后　纵轴 舌位高还是低
            </span>
          </div>
          <div className="grid-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th />
                  {d.vowelCols.map((c) => <th key={c.id} scope="col">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {d.vowelRows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.label}</th>
                    {d.vowelCols.map((c) => box(
                      vowels.filter((v) => v.row === r.id && v.col === c.id),
                      `${r.id}-${c.id}`,
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 双元音是从起点滑向终点的，按**起点**归格；不说这一句，
              「aɪ 怎么在低·央」会变成一个没人解答的疑问。 */}
          <span className="mono-note">
            双元音（eɪ oʊ aɪ aʊ ɔɪ）按起点摆——它是从这一格滑向别处的
          </span>
        </section>
      </Space>
    </div>
  );
}
