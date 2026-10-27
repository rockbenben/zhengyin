import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Radio, Space, Typography, message } from 'antd';
import { api } from '../api';
import type { NoteDraft, NoteScope, SavedNote } from '../types';
import NoteBody from './NoteBody';

const splitPhonemes = (raw: string): string[] =>
  raw.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
const splitWords = (raw: string): string[] =>
  raw.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);

/**
 * AI 草稿的编辑器。
 *
 * 服务端已经把 frontmatter 拼好了，这里只让用户改「写什么」：标题、范围、取值、错法、正文。
 * 保存仍然走同一道校验（自检法/对比训练、形近字符、个人断言），所以 400 的原话要原样摆出来——
 * 那是一句能照着改的提示，不是「保存失败」。
 */
export default function NoteEditor({ draft, open, onClose, onSaved }: {
  draft: NoteDraft | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (saved: SavedNote) => void;
}) {
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<NoteScope>('phoneme');
  const [values, setValues] = useState('');
  const [contrasts, setContrasts] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !draft) return;
    setTitle(draft.title);
    setScope(draft.scope);
    setValues(draft.values.join(', '));
    setContrasts(draft.contrasts.join(', '));
    setBody(draft.body);
    setErr(null);
  }, [open, draft]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.saveNote({
        title: title.trim() || 'AI 笔记',
        scope,
        values: scope === 'phoneme' ? splitPhonemes(values) : splitWords(values),
        contrasts: splitPhonemes(contrasts),
        body,
      });
      message.success('笔记已保存到本机');
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title="写成笔记"
      width={920}
      onCancel={saving ? undefined : onClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={saving}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void save()}>保存</Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" className="measure" style={{ marginBottom: 0 }}>
          笔记对这台机器的所有使用者可见：只写知识（怎么发、怎么自检、怎么对比练），
          不要写「你有这个毛病」。服务端会检查「自检法」「对比训练」两节。
        </Typography.Paragraph>

        <div>
          <Typography.Text strong>标题</Typography.Text>
          <Input aria-label="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value as NoteScope)}>
          <Radio value="phoneme">讲这个音</Radio>
          <Radio value="word">讲这个词</Radio>
        </Radio.Group>

        <div>
          <Typography.Text strong>
            {scope === 'phoneme' ? '适用音素（IPA，逗号分隔）' : '适用词（逗号分隔，短语可带空格）'}
          </Typography.Text>
          <Input
            aria-label="适用范围"
            value={values}
            placeholder={scope === 'phoneme' ? '如 l, n' : '如 machine, machine learning'}
            onChange={(e) => setValues(e.target.value)}
          />
        </div>

        <div>
          <Typography.Text strong>错法音素（可选，逗号分隔）</Typography.Text>
          <Input
            aria-label="错法音素"
            value={contrasts}
            placeholder="如 s, f（只在这篇还教「念成什么」时填）"
            onChange={(e) => setContrasts(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div style={{ flex: '1 1 360px', minWidth: 0 }}>
            <Typography.Text strong>正文（markdown）</Typography.Text>
            <Input.TextArea
              aria-label="正文"
              value={body}
              rows={16}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div style={{ flex: '1 1 360px', minWidth: 0 }}>
            <Typography.Text strong>预览</Typography.Text>
            <div style={{ border: '1px solid var(--rule)', padding: 12, minHeight: 200 }}>
              {body.trim() ? <NoteBody markdown={body} /> : (
                <Typography.Text type="secondary">正文写点什么，这里会显示渲染后的样子。</Typography.Text>
              )}
            </div>
          </div>
        </div>

        {err && (
          <Alert
            type="error"
            showIcon
            message="没保存成功"
            description={<span style={{ whiteSpace: 'pre-wrap' }}>{err}</span>}
          />
        )}
      </Space>
    </Modal>
  );
}
