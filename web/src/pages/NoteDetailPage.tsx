import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link, useParams } from 'react-router';
import { Button, Space, Spin, Tag, Typography } from 'antd';
import NoteBody from '../components/NoteBody';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import PageResult from '../components/PageResult';
import type { NoteDetail } from '../types';
import { SEVERITY_LABEL } from '../lib/notation';

/**
 * **只有录音里反复出现过的才挂标签。**
 *
 * 原来三档都挂：「已确认短板 / 待观察 / 一般知识」。而后两档说的是
 * "这东西还没在你身上出现过"——给它盖一个章，等于把一份资料摆成了对你的判定。
 * 没在这个人身上出现过的东西，就没必要在界面上显示。
 *
 * 现在没出现过的就不挂，那一页就是一篇讲解，本来也该是。
 * 档次怎么定见 server/src/profile.ts 的 severityOf——按你自己的评测记录推。
 */
// 颜色**不能用 error**（红）。theme.ts 白纸黑字：「红色只留给真正的破坏性操作」，
// 而这里说的是"你这个音反复对不上"——那是工艺判断，不是要删东西。
//
// 用 processing 而不是 info：**antd 的 Tag 状态色只有五个**
// （success / processing / error / default / warning，见 antd/_util/colors）。
// 写 'info' 会被当成一个字面颜色字符串，不是合法 CSS 颜色，标签直接没样式——
// 查 antd 的类型定义才能确认这一点。
// processing 走的正是 colorInfo，也就是这套视觉的第二版油墨。
const SEVERITY_TAG: Partial<Record<NoteDetail['severity'], { text: string; color: 'processing' }>> = {
  confirmed: { text: SEVERITY_LABEL.confirmed!, color: 'processing' },
};

// 笔记详情页：正文是服务端存的 markdown，底部「反查」出这条笔记挂在哪些已查过的词条上
// （服务端 entryHasNote() 算出来的 examples），每个例词都能点回 /word/:text。
export default function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [note, setNote] = useState<NoteDetail | null>(null);
  // 标题要等笔记读回来。读回来之前只显示应用名，别摆一个 undefined 在标签页上
  useTitle(note?.title);
  // 跟别处一样：连不上服务和这篇笔记没了，是两件事。原来一律说「笔记不存在」，
  // 服务一停，每一篇笔记都变成"不存在"。
  const [error, setError] = useState<null | 'offline' | 'missing'>(null);

  useEffect(() => {
    setNote(null);
    setError(null);
    if (!id) return;
    api.getNote(id).then(setNote).catch((e) => setError(isOffline(e) ? 'offline' : 'missing'));
  }, [id]);

  if (error === 'offline') return <Offline />;
  if (error) {
    return (
      <PageResult
        slug="找不到"
        title="没有这篇笔记"
        extra={<Link to="/notes"><Button type="primary">看全部笔记</Button></Link>}
      >
        {/* 原来写「它可能已经被删除或改过 id」。「id」是代码里的说法，
            而且这句话只解释了原因、没给下一步——人卡在这一页出不去。 */}
        可能是文件被删了或者改了名。去笔记列表里看看现在有哪些。
      </PageResult>
    );
  }
  if (!note) return <Spin style={{ marginTop: 48 }} />;

  const meta = SEVERITY_TAG[note.severity];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space align="center" wrap>
        <PageHead slug="发音笔记" title={note.title} />
        {meta && <Tag color={meta.color}>{meta.text}</Tag>}
      </Space>

      <NoteBody markdown={note.markdown} />

      <div>
        {/* 「挂在这条笔记上」是这份代码内部的说法（笔记挂到词上、挂上来），
            用户那边没有"挂"这回事——他看到的是这篇讲解会在哪些词的页面上出现。
            空态也一样：「还没有例词」说的是库里的状态，得说清是**你的库**还空着，
            不然读起来像这篇笔记本身缺了点什么。 */}
        <Typography.Title level={3} style={{ marginBottom: 8 }}>库里哪些词会看到这篇</Typography.Title>
        {note.examples.length === 0 ? (
          <Typography.Text type="secondary">
            {/* 别写「含这个音的词」：讲词的笔记（frontmatter 的 words:）按词匹配，
                跟音素无关，那句话对它是假的。说「这篇讲到的词」两种都成立。 */}
            还没有——库里还没有这篇讲到的词。去<Link to="/">首页</Link>查一个就会出现在这里。
          </Typography.Text>
        ) : (
          <Space wrap size={8}>
            {note.examples.map((w) => (
              <Link key={w} to={`/word/${encodeURIComponent(w)}`}>
                <Tag>{w}</Tag>
              </Link>
            ))}
          </Space>
        )}
      </div>
    </Space>
  );
}
