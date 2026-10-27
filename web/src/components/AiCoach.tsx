import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Space, Spin, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { api } from '../api';
import type { AiExplainResult, AiStatusInfo, NoteDraft, SavedNote } from '../types';
import NoteBody from './NoteBody';
import NoteEditor from './NoteEditor';

/**
 * 词条页的 AI 讲解。
 *
 * 三道门都必须在**点之前**说清楚：没配、没同意、词典里没这个词。
 * 原来那种「摆一个点下去才报错的按钮」在这个项目里已经出过好几次。
 */
export default function AiCoach({ text, target, enabled = true, onNoteSaved }: {
  text: string;
  target?: string;
  enabled?: boolean;
  onNoteSaved?: (saved: SavedNote) => void;
}) {
  const [status, setStatus] = useState<AiStatusInfo | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [result, setResult] = useState<AiExplainResult | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    api.aiStatus()
      .then((s) => { if (alive) setStatus(s); })
      .catch((e) => { if (alive) setStatusErr(e instanceof Error ? e.message : '读取 AI 状态失败'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  function begin(): { ac: AbortController; mine: number } {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const mine = ++seq.current;
    return { ac, mine };
  }

  async function explain() {
    const { ac, mine } = begin();
    setExplaining(true);
    setActionErr(null);
    setResult(null);
    try {
      const r = await api.aiExplain(text, target, ac.signal);
      if (mine === seq.current) setResult(r);
    } catch (e) {
      if (mine === seq.current && !ac.signal.aborted) {
        setActionErr(e instanceof Error ? e.message : '讲解失败');
      }
    } finally {
      if (mine === seq.current) setExplaining(false);
    }
  }

  async function makeDraft() {
    const { ac, mine } = begin();
    setDrafting(true);
    setActionErr(null);
    try {
      const d = await api.aiNoteDraft(text, target, ac.signal);
      if (mine !== seq.current) return;
      setDraft({ title: d.title, scope: d.scope, values: d.values, contrasts: d.contrasts, body: d.body });
      setEditorOpen(true);
    } catch (e) {
      if (mine === seq.current && !ac.signal.aborted) {
        setActionErr(e instanceof Error ? e.message : '生成草稿失败');
      }
    } finally {
      if (mine === seq.current) setDrafting(false);
    }
  }

  if (statusErr) {
    return (
      <Card title="AI 讲解" size="small">
        <Alert type="error" showIcon message="读取 AI 状态失败" description={statusErr} />
      </Card>
    );
  }
  if (!status) {
    return <Card title="AI 讲解" size="small"><Spin /></Card>;
  }

  if (!enabled) {
    return (
      <Card title="AI 讲解" size="small">
        <Typography.Text type="secondary">
          词典里没有这个词的音标，AI 没法逐音素讲解。可以听上面的音频跟着念。
        </Typography.Text>
      </Card>
    );
  }

  if (!status.configured || !status.consent) {
    return (
      <Card title="AI 讲解" size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph className="measure" style={{ marginBottom: 0 }}>
            {status.configured
              ? `已经找到 ${status.provider}，但还没同意把发音档案和相关笔记发给它。`
              : `先接上 AI：在设置里选一家接口，或者用本机已经装好的命令行工具。${status.reason ? `（${status.reason}）` : ''}`}
          </Typography.Paragraph>
          <Link to="/settings"><Button>去设置</Button></Link>
        </Space>
      </Card>
    );
  }

  return (
    <Card
      title={
        <Space wrap>
          <span>AI 讲解</span>
          {result && <Tag>{result.provider}</Tag>}
        </Space>
      }
      size="small"
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
          按下去才会把发音档案、相关笔记和这次的错误发给 {status.provider}；不按不发。
        </Typography.Text>

        <Space wrap>
          <Button type="primary" loading={explaining} onClick={() => void explain()}>
            {result ? '重新讲解' : 'AI 讲解'}
          </Button>
          {result && (
            <Button loading={drafting} onClick={() => void makeDraft()}>
              写成笔记
            </Button>
          )}
          {result && (
            <Link to={`/assistant?word=${encodeURIComponent(text)}`}>
              <Button>继续问助教</Button>
            </Link>
          )}
        </Space>

        {actionErr && <Alert type="error" showIcon message={actionErr} />}

        {result && (
          <>
            <NoteBody markdown={result.markdown} />
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              由 {result.provider} 生成
              {result.sources.length > 0 ? '；参考：' : '；这次没有匹配到已有笔记。'}
              {result.sources.map((s, i) => (
                <span key={s.id}>
                  {i > 0 ? '、' : ''}
                  <Link to={`/notes/${s.id}`}>{s.title}</Link>
                </span>
              ))}
            </Typography.Text>
          </>
        )}
      </Space>

      <NoteEditor
        draft={draft}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSaved={(saved) => onNoteSaved?.(saved)}
      />
    </Card>
  );
}
