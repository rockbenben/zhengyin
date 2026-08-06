import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link } from 'react-router';
import { Collapse, List, Space, Spin, Typography } from 'antd';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import PageResult, { LoadFailed } from '../components/PageResult';
import Notice from '../components/Notice';

import type { NoteGroups, NoteListItem, Shelf } from '../types';

/**
 * 这一页只回答一个问题：**你的短板是什么。**
 *
 * 原来它按 severity 摆成三组，标题是「已确认短板 / 待观察 / 一般知识」。
 * 后两组恰恰是**还没在你身上出现过的东西**，却跟你的短板并排摆在同一页上。
 * 「待观察」「一般知识」这两档本身就讲不清是什么。没在这个人身上出现过的
 * 东西没必要在界面上显示；积攒下来的可以当素材，但只有真出现过的才该进这里。
 *
 * 所以现在是**一个维度**：录音里有没有反复出现过。其余全部折进下面的「素材库」，
 * 默认收起，并且明说它们还没在你身上出现过。「待观察」不再是一个独立的层级——
 * 它只是素材里附一句"出现过但还不够"的事实，不是另立的第三档。
 */
const SHELF_LABEL: Record<Shelf, string> = {
  consonant: '辅音',
  vowel: '元音',
  structure: '位置与连缀',
  word: '讲某几个词的',
};

/** 辅音那一格额外说清它是按什么排的——其余三格没有第二层，不用交代 */
const SHELF_META: Partial<Record<Shelf, string>> = { consonant: '按部位从唇到喉' };

/**
 * 素材库：按书架摆，不是一条平铺列表。
 *
 * ── 为什么改 ──
 *
 * 素材库是**共享资料**，职责是被翻到，不是被推荐（推荐是上面那一档的活，判据是你的证据）。
 * 而它原来是一条平铺列表：17 篇时还能扫完，攒到几十篇就没有入口了——
 * 想找「讲 θ 的那篇」只能从头看。实测过命中数怎么涨：85 篇笔记时长词命中 26 篇。
 *
 * ── 分组不是新发明的 ──
 *
 * 四格（辅音 / 元音 / 位置与连缀 / 讲词的）就是 `triggers` 本来的形状，
 * 仓库里 17 篇实际数据一篇不跨类。辅音再按部位排复用 `/phonemes` 和统计页音位格
 * 同一条轴，排完 l-n、n-ŋ、r 三篇齿龈的自动挨在一起。
 *
 * **顺序和分类全在服务端**（shelf.ts）：这里只做"遇到新的 shelf/place 就起一段"，
 * 不在前端复制一份分类学——判据只能有一处。
 */
function Shelves({ notes, seen }: { notes: NoteListItem[]; seen: Set<string> }) {
  const out: React.ReactNode[] = [];
  let shelf: Shelf | null = null;
  let place: string | null = null;

  notes.forEach((n, i) => {
    if (n.shelf !== shelf) {
      shelf = n.shelf;
      place = null;
      const count = notes.filter((x) => x.shelf === n.shelf).length;
      out.push(
        <div key={`s-${n.shelf}`} style={{ marginTop: i === 0 ? 0 : 22, marginBottom: 8 }}>
          <span className="slug">{SHELF_LABEL[n.shelf]} · {count} 篇</span>
          {SHELF_META[n.shelf] && (
            <span className="slug" style={{ marginLeft: 10, color: 'var(--quiet)' }}>
              （{SHELF_META[n.shelf]}）
            </span>
          )}
        </div>,
      );
    }
    if (n.placeLabel && n.place !== place) {
      place = n.place;
      out.push(<div key={`p-${n.shelf}-${n.place}`} style={{ margin: '10px 0 2px' }}>
        <span className="op-tick">{n.placeLabel}</span>
      </div>);
    }
    out.push(
      <div
        key={n.id}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap',
          padding: '7px 0', borderTop: '1px solid var(--rule)',
        }}
      >
        {/* 左边这一列是**路标**，只干一件事：让眼睛扫着找。
            音素笔记摆 IPA——用户认的是 /θ/，不是「齿间擦音」四个字；
            讲词的摆那几个词（标题「-ine 拼写陷阱」说不出是哪些词）。
            结构笔记留空：标题本身就是「词尾的暗 l」「闪音 T」，
            再把 explainTag 那句「元音后的暗 L」塞进 92px 里只是把同一件事说两遍。 */}
        <span className="ipa" style={{ minWidth: 92, color: 'var(--blue)', fontSize: 14 }}>
          {n.shelf === 'consonant' || n.shelf === 'vowel' ? n.covers.join(' ')
            : n.shelf === 'word' ? n.covers.slice(0, 2).join('、') + (n.covers.length > 2 ? '…' : '')
              : ''}
        </span>
        <Link to={`/notes/${encodeURIComponent(n.id)}`} style={{ fontSize: 14.5 }}>{n.title}</Link>
        {/* **标出例外，不标常态**（跟首页那张表的「发音」列同一条）。
            库里一个词都没有时，每行都写「库里还没有例词」——17 行同一句话，
            零信息量还占满右栏。有例词才说，说的就是「这篇现在能点开看例子」。 */}
        {(n.exampleCount > 0 || seen.has(n.id)) && (
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--quiet)' }}>
            {n.exampleCount > 0 && `${n.exampleCount} 个例词`}
            {n.exampleCount > 0 && seen.has(n.id) && '　·　'}
            {seen.has(n.id) && '出现过，但还不够确定'}
          </span>
        )}
      </div>,
    );
  });

  return <div>{out}</div>;
}

export default function NotesPage() {
  useTitle('发音笔记');
  const [groups, setGroups] = useState<NoteGroups | null>(null);
  const [error, setError] = useState<null | 'offline' | 'failed'>(null);

  useEffect(() => {
    api.listNotes().then((d) => setGroups(d.groups)).catch((e) => setError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  // 「服务可能没启动」点出了原因，却跟着一句治不了它的建议——服务没起来，
  // 重试一百次也还是没起来。连不上就给那块写着怎么启动的屏。
  if (error === 'offline') return <Offline />;
  if (error) {
    return (
      <LoadFailed what="笔记" />
    );
  }
  if (!groups) return <Spin style={{ marginTop: 48 }} />;

  const mine = groups.confirmed;
  // 服务端已按书架排好序（shelf.ts），但 watch/info 是按证据分的两组，
  // 拼起来就把那个顺序打乱了——按 order 排回去。前端因此不必知道书架怎么分。
  const material = [...groups.watch, ...groups.info].sort((a, b) => a.order - b.order);
  const seen = new Set(groups.watch.map((n) => n.id));

  if (mine.length === 0 && material.length === 0) {
    return (
      <PageResult slug="发音笔记" title="还没有笔记">
        跟 AI 聊你念不准的音，它写的笔记会出现在这里。
      </PageResult>
    );
  }

  const row = (note: NoteListItem) => (
    <List.Item key={note.id}>
      <Space direction="vertical" size={3} style={{ width: '100%' }}>
        <Link to={`/notes/${encodeURIComponent(note.id)}`}>
          <Typography.Text strong>{note.title}</Typography.Text>
        </Link>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          {/* 触发标签是写笔记的人用的，不是念的人用的——原来每行铺一排
              phoneme:l / cluster-onset:kl 这样的 Tag，对使用者没有意义 */}
          库里有 {note.exampleCount} 个例词
          {seen.has(note.id) && '　·　在你的录音里出现过，但还不够确定'}
        </Typography.Text>
      </Space>
    </List.Item>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <PageHead
        slug="发音笔记"
        title={mine.length > 0 ? `录音里反复出现 ${mine.length} 篇` : '还没有反复出现的问题'}
        // 讲音的和讲词的门槛不一样（server 的 severityOf）：讲词的笔记讲的就是那几个词，
        // 没有泛化主张可提，要求它"不止在一个词上"是结构上不可能满足的。
        meta="反复出错才会进这里；讲某个音的还要求不止在一个词上出现过"
      />

      {mine.length > 0 ? (
        <List bordered dataSource={mine} renderItem={row} />
      ) : (
        <Notice tone="quiet" title="这不是坏事">
          这份清单是<strong>练出来</strong>的，不是一开始就该有的。多录几次，
          {'某个音要是反复出错、而且不止在一个词上，工具会自己把它升到这里——'}
          {'在那之前，下面那些只是可以翻的资料，不是对你的判定。'}
          {/* 仓库自带的笔记是给**上一个使用者**写的：里面举的例子和次数是他的录音里
              量出来的。不说清的话，新用户会把别人的诊断当成自己的——这个仓库为同一件事
              已经改过一次 severity 的判据。
              **别在这里引笔记正文的原话**：那种引用会烂，实测烂过一次（笔记去人身化之后，
              这里还在引一句已经不存在的句子）。只说关系，不复述原文。 */}
          <br />
          仓库自带的那几篇是<strong>上一个使用者练出来的</strong>，
          {'里面举的例子和次数是他的录音里量出来的。当讲解读没问题，但那些数不是你的。'}
        </Notice>
      )}

      {material.length > 0 && (
        <Collapse
          size="small"
          items={[{
            key: 'material',
            label: (
              <span>
                素材库 · {material.length} 篇
                <Typography.Text type="secondary" style={{ fontSize: 12.5, marginLeft: 10 }}>
                  还没在你身上出现过，或者出现得还不够——当资料看
                </Typography.Text>
              </span>
            ),
            children: <Shelves notes={material} seen={seen} />,
          }]}
        />
      )}
    </Space>
  );
}
