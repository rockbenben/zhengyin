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

  useEffect(() => {
    api.phonemes().then(setD).catch((e) => setError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  if (error === 'offline') return <Offline />;
  if (error) {
    return (
      <LoadFailed what="音素表" />
    );
  }
  if (!d) return <Spin style={{ marginTop: 48 }} />;

  const consonants = d.phones.filter((p) => p.kind === 'consonant');
  const vowels = d.phones.filter((p) => p.kind === 'vowel');

  const cell = (p: PhonemeList['phones'][number]) => (
    <Link
      key={p.ipa}
      to={`/phoneme/${encodeURIComponent(p.ipa)}`}
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', minWidth: 62, padding: '6px 4px' }}
    >
      <span className="ipa" style={{ fontSize: 21, fontWeight: p.noteCount > 0 ? 700 : 400 }}>{p.ipa}</span>
      <span className="op-tick" style={{ marginTop: 2 }}>
        {p.exampleCount > 0 ? `${p.exampleCount} 词` : '—'}
        {p.noteCount > 0 && ' · 有笔记'}
      </span>
    </Link>
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

      <Typography.Paragraph type="secondary" style={{ maxWidth: '60ch' }}>
        点进任意一个音，看它<strong>客观上怎么发</strong>（舌尖顶哪、气流走哪、唇形）
        {'以及库里含它的例词。这跟'}<Link to="/notes">笔记</Link>是两件事：
        {'这里跟谁在念无关，笔记讲的是'}<strong>你自己</strong>在某个音或某个词上的问题。
      </Typography.Paragraph>

      {/* 浏览 41 个音的人下一句话必然是"那我该重点注意哪几个"。
          按**影响听懂的程度**排，不按难度——前三条改了收益最大。
          完整版在 美音要点-中文母语者.md，这里只留能立刻行动的那几条。 */}
      <div style={{ borderLeft: '3px solid var(--blue)', paddingLeft: 18, margin: '4px 0 8px' }}>
        <span className="slug" style={{ color: 'var(--blue)' }}>中文母语者最该注意的</span>
        <ol style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 14, lineHeight: 2, maxWidth: '62ch' }}>
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
            的要点是<strong>越轻越对</strong>——中文没有"半个字"，本能会把它念成一个完整的字。
          </li>
          <li>
            <Link to={`/phoneme/${encodeURIComponent('l')}`}>l</Link> 和{' '}
            <Link to={`/phoneme/${encodeURIComponent('n')}`}>n</Link> 舌位完全一样，
            {'只差气流走两侧还是鼻腔。'}<strong>捏住鼻子</strong>：l 声音不变，n 发不出来。
          </li>
        </ol>
      </div>

      <Space direction="vertical" size={26} style={{ width: '100%', marginTop: 8 }}>
        <section>
          <span className="slug">辅音 · {consonants.length} 个（按部位从唇到喉）</span>
          <Space direction="vertical" size={14} style={{ width: '100%', marginTop: 12 }}>
            {d.places
              .map((pl) => ({ pl, items: consonants.filter((c) => c.place === pl.id) }))
              .filter((g) => g.items.length > 0)
              .map(({ pl, items }) => (
                <div key={pl.id}>
                  <span className="op-tick">{pl.label}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {items.map(cell)}
                  </div>
                </div>
              ))}
          </Space>
        </section>

        <section style={{ borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
          <span className="slug">元音 · {vowels.length} 个</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 12 }}>
            {vowels.map(cell)}
          </div>
        </section>
      </Space>
    </div>
  );
}
