import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Alert, Button, Card, Input, Popconfirm, Space, Spin, Tag, Typography, message } from 'antd';
import { Link, useSearchParams } from 'react-router';
import { api, isOffline } from '../api';
import type { AiSource, AiStatusInfo, ChatMessage } from '../types';
import NoteBody from '../components/NoteBody';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import { LoadFailed } from '../components/PageResult';

/**
 * AI 助教。
 *
 * 对话按**当前用户**存在服务端（data/users/<名字>/ai-chat.json），跟这台机器上的
 * 其他人分开；换用户之后看到的是另一段历史。历史只留最近 100 条，它是对话，不是档案。
 */
export default function AssistantPage() {
  useTitle('AI 助教');
  const [search] = useSearchParams();
  const startWord = (search.get('word') ?? '').trim().toLowerCase();
  const [focusWord, setFocusWord] = useState(startWord);
  const [input, setInput] = useState(
    () => (startWord ? `讲讲「${startWord}」：它难在哪，我该怎么练？` : ''),
  );
  const [status, setStatus] = useState<AiStatusInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loadError, setLoadError] = useState<null | 'offline' | 'failed'>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sources, setSources] = useState<AiSource[]>([]);
  const [provider, setProvider] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.aiStatus(), api.aiChat()])
      .then(([s, h]) => { setStatus(s); setMessages(h.messages); })
      .catch((e) => setLoadError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  if (loadError === 'offline') return <Offline />;
  if (loadError) return <LoadFailed what="AI 助教" />;
  if (!status || !messages) return <Spin style={{ marginTop: 48 }} />;

  const ready = status.configured && status.consent;

  async function send() {
    const text = input.trim();
    if (!text || sending || !ready) return;
    setSending(true);
    setErr(null);

    // 先把手里的这句话放上屏。失败时撤回——服务端没存，留在屏上就成了假历史。
    const pending: ChatMessage = { role: 'user', content: text, at: new Date().toISOString() };
    setMessages((m) => [...(m ?? []), pending]);
    setInput('');

    try {
      const r = await api.sendAiChat(text, focusWord || undefined);
      setMessages((m) => [...(m ?? []), {
        role: 'assistant', content: r.reply, at: r.at ?? new Date().toISOString(),
      }]);
      setSources(r.sources);
      setProvider(r.provider);
      setFocusWord('');
    } catch (e) {
      setMessages((m) => (m ?? []).filter((x) => x !== pending));
      setInput(text);
      setErr(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  }

  async function clear() {
    try {
      await api.clearAiChat();
      setMessages([]);
      setSources([]);
      setProvider(null);
      message.success('对话已清空');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '清空失败');
    }
  }

  return (
    <Space direction="vertical" size={40} style={{ width: '100%' }}>
      <PageHead
        slug="AI"
        title="AI 助教"
        meta={ready
          ? `由 ${status.provider} 回答；对话只存在这台机器上`
          : '还没接上 AI'}
      />

      {!ready && (
        <Alert
          type="info"
          showIcon
          message={status.configured
            ? `已经找到 ${status.provider}，但还没同意把发音档案和相关笔记发给它。`
            : `先接上 AI：选一家接口，或者用本机已经装好的命令行工具。${status.reason ? `（${status.reason}）` : ''}`}
          description={<Link to="/settings">去设置里接上</Link>}
        />
      )}

      {status.mode === 'cli' && (
        <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
          命令行模式：每发一条消息都会重新启动一次工具，所以会比接口模式慢一些。
        </Typography.Text>
      )}

      <Card
        title={<Space wrap><span>对话</span>{provider && <Tag>{provider}</Tag>}</Space>}
        extra={
          messages.length > 0 ? (
            <Popconfirm
              title="清空对话？"
              description="只清当前用户在这台机器上的记录，不能恢复"
              okText="清空"
              okType="danger"
              cancelText="取消"
              onConfirm={() => void clear()}
            >
              <Button danger size="small">清空</Button>
            </Popconfirm>
          ) : null
        }
      >
        <div className="chat-log">
          {messages.length === 0 && !sending && (
            <Typography.Paragraph type="secondary" className="measure" style={{ marginBottom: 0 }}>
              可以问某个音怎么发、这个词为什么总错、每天该练什么。回答会带上你的发音档案和相关笔记。
            </Typography.Paragraph>
          )}

          {messages.map((m, i) => (
            <div key={`${m.at}-${i}`} className={`chat-msg ${m.role}`}>
              <span className="slug chat-who">{m.role === 'user' ? '你' : '助教'}</span>
              {m.role === 'assistant'
                ? <NoteBody markdown={m.content} />
                : <p className="chat-text">{m.content}</p>}
            </div>
          ))}

          {sending && (
            <div className="chat-msg assistant">
              <span className="slug chat-who">助教</span>
              <Typography.Text type="secondary">正在想…</Typography.Text>
            </div>
          )}
        </div>

        {sources.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <Typography.Text type="secondary" style={{ fontSize: 13, marginRight: 8 }}>这次参考：</Typography.Text>
            {sources.map((s) => (
              <Tag key={s.id}><Link to={`/notes/${s.id}`}>{s.title}</Link></Tag>
            ))}
          </div>
        )}
      </Card>

      <Card title="问一句" size="small">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {focusWord && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              这一问会带上词条「{focusWord}」的最近录音和笔记。
            </Typography.Text>
          )}
          <Input.TextArea
            aria-label="对 AI 助教说"
            value={input}
            rows={3}
            maxLength={4000}
            showCount
            disabled={!ready || sending}
            placeholder="比如：/l/ 和 /n/ 我总是分不清，该怎么练？"
            onChange={(e) => setInput(e.target.value)}
          />
          <Space wrap>
            <Button
              type="primary"
              loading={sending}
              disabled={!ready || !input.trim()}
              onClick={() => void send()}
            >
              发送
            </Button>
            {!ready && <Typography.Text type="secondary" style={{ fontSize: 13 }}>接上 AI 之后才能发。</Typography.Text>}
          </Space>
          {err && <Alert type="error" showIcon message={err} />}
        </Space>
      </Card>
    </Space>
  );
}
