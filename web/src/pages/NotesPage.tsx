import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link } from 'react-router';
import { Collapse, List, Space, Spin, Typography } from 'antd';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import PageResult, { LoadFailed } from '../components/PageResult';
import Notice from '../components/Notice';
import type { NoteGroups, NoteListItem } from '../types';

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
  // watch 排在前面：它们至少在你身上出现过，比纯资料更值得先看一眼
  const material = [...groups.watch, ...groups.info];
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
            children: <List dataSource={material} renderItem={row} />,
          }]}
        />
      )}
    </Space>
  );
}
