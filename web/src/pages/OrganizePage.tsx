import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import {
  Alert, Button, Card, Input, Modal, Radio, Space, Spin, Tag, Typography, message,
} from 'antd';
import { Link } from 'react-router';
import { api, isOffline } from '../api';
import type { AgentState, AgentStatusInfo, AgentTask, AiStatusInfo } from '../types';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import { LoadFailed } from '../components/PageResult';

const STATE_LABEL: Record<AgentState, string> = {
  idle: '还没整理过',
  running: '正在整理',
  done: '整理完成',
  error: '整理出错',
  cancelled: '已取消',
  undone: '已撤销',
};

const KIND_LABEL = {
  added: '新增', modified: '修改', removed: '删除',
} as const;

const TASK_HINT: Record<Exclude<AgentTask, 'custom'>, string> = {
  organize: '按发音档案里的「该补的笔记」整理：缺的补上，已有的补充，不重复造同主题的。',
  profile: '按录音记录和现有笔记更新档案手写两节；不够门槛的留在「待观察」或干脆不写。',
};

function ChangeList({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <Typography.Text strong>{label}（{paths.length}）</Typography.Text>
      {paths.map((p) => (
        <div key={p} className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{p}</div>
      ))}
    </div>
  );
}

/**
 * AI 整理。
 *
 * 这一页的重点不是"让 AI 改文件"，而是**改之前说清边界、改之后看得见改了什么、
 * 不满意能整批撤销**。所以确认框里把"不能改"的几样一一列出来，结果区按
 * 新增/修改/删除摆路径，越界改动单独警告（那部分撤销不碰）。
 */
export default function OrganizePage({ pollMs = 1000 }: { pollMs?: number }) {
  useTitle('AI 整理');
  const [ai, setAi] = useState<AiStatusInfo | null>(null);
  const [status, setStatus] = useState<AgentStatusInfo | null>(null);
  const [loadError, setLoadError] = useState<null | 'offline' | 'failed'>(null);
  const [task, setTask] = useState<AgentTask>('organize');
  const [note, setNote] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.aiStatus(), api.aiAgentStatus()])
      .then(([a, s]) => { setAi(a); setStatus(s); })
      .catch((e) => setLoadError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  // 跑的时候每秒问一次。state 从 running 变走，effect 自己会停。
  useEffect(() => {
    if (status?.state !== 'running') return undefined;
    let alive = true;
    const timer = setInterval(() => {
      api.aiAgentStatus()
        .then((s) => { if (alive) setStatus(s); })
        .catch(() => { /* 轮询失败不打扰；下一次还会试 */ });
    }, pollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [status?.state, pollMs]);

  if (loadError === 'offline') return <Offline />;
  if (loadError) return <LoadFailed what="AI 整理" />;
  if (!ai || !status) return <Spin style={{ marginTop: 48 }} />;

  const gate = ai.mode !== 'cli'
    ? '整理需要命令行代理：接口模式只能讲解，不能读写文件。'
    : !ai.configured
      ? `没找到可用的命令行工具。${ai.reason ?? ''}`
      : !ai.consent
        ? `已经找到 ${ai.provider}，但还没同意让它读写这台机器上的笔记和档案。`
        : null;

  const running = status.state === 'running';
  const elapsed = status.startedAt
    ? Math.max(0, Math.round((Date.now() - status.startedAt) / 1000))
    : 0;
  const changes = status.changed;
  const changedCount = changes
    ? changes.added.length + changes.modified.length + changes.removed.length
    : 0;
  const canUndo = !running && status.state !== 'idle' && status.state !== 'undone' && Boolean(status.runId);

  async function start() {
    setStarting(true);
    setErr(null);
    try {
      await api.aiAgentRun(task, task === 'custom' ? note.trim() : undefined);
      setConfirmOpen(false);
      setStatus(await api.aiAgentStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : '没能开始整理');
      setConfirmOpen(false);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    setErr(null);
    try {
      await api.aiAgentCancel();
      setStatus(await api.aiAgentStatus());
    } catch (e) {
      setErr(e instanceof Error ? e.message : '取消失败');
    }
  }

  async function undo() {
    setUndoing(true);
    setErr(null);
    try {
      setStatus(await api.aiAgentUndo());
      message.success('已撤销这次整理');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '撤销失败');
    } finally {
      setUndoing(false);
    }
  }

  return (
    <Space direction="vertical" size={40} style={{ width: '100%' }}>
      <PageHead
        slug="AI"
        title="AI 整理"
        meta="只动本机笔记和当前用户档案的手写两节；跑完可以整批撤销"
      />

      {gate && (
        <Alert
          type="info"
          showIcon
          message={gate}
          description={<Link to="/settings">去设置里接上命令行代理</Link>}
        />
      )}

      {err && <Alert type="error" showIcon message={err} />}

      {running && (
        <Card
          title={<Space wrap><span>正在整理</span><Tag color="processing">{status.cancelling ? '正在取消' : `已用 ${elapsed}s`}</Tag></Space>}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Typography.Text type="secondary" className="measure">
              代理正在按你的档案整理笔记。这里会实时显示它说了什么；随时可以取消。
            </Typography.Text>
            <pre className="mono-note" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', margin: 0 }}>
              {status.logs.join('\n') || '（还没有输出）'}
            </pre>
            <Button danger loading={status.cancelling} onClick={() => void cancel()}>
              取消整理
            </Button>
          </Space>
        </Card>
      )}

      {!running && status.state !== 'idle' && (
        <Card
          title={<Space wrap><span>{STATE_LABEL[status.state]}</span>{status.runId && <Tag>{status.runId}</Tag>}</Space>}
          extra={canUndo ? (
            <Button danger loading={undoing} onClick={() => void undo()}>
              撤销这次整理
            </Button>
          ) : null}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {status.error && <Alert type="error" showIcon message={status.error} />}

            {status.state === 'undone' && (
              <Alert type="success" showIcon message="已撤销" description="本机笔记和档案已回到整理前；越界改动不会恢复。" />
            )}

            {changedCount === 0 ? (
              <Typography.Text type="secondary">这次没有改动任何文件。</Typography.Text>
            ) : (
              <div>
                <ChangeList label="新增" paths={changes?.added ?? []} />
                <ChangeList label="修改" paths={changes?.modified ?? []} />
                <ChangeList label="删除" paths={changes?.removed ?? []} />
              </div>
            )}

            {status.outOfScope.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="代理动了不该动的文件"
                description={
                  <>
                    <div>这些不在撤销范围内，请自己检查一下：</div>
                    {status.outOfScope.map((x) => (
                      <div key={x.path} className="mono" style={{ fontSize: 12.5 }}>
                        {x.path}（{KIND_LABEL[x.kind]}）
                      </div>
                    ))}
                  </>
                }
              />
            )}

            {status.noteWarnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="这些笔记没通过检查"
                description={status.noteWarnings.map((w, i) => <div key={`${i}-${w}`}>{w}</div>)}
              />
            )}

            {status.autoOk === false && (
              <Alert
                type="warning"
                showIcon
                message="发音档案的 AUTO 统计标记被改坏了"
                description="下次评测可能不再更新统计。撤销这次整理可以恢复。"
              />
            )}
          </Space>
        </Card>
      )}

      {!gate && (
        <Card title={status.state === 'idle' ? '想让 AI 做什么' : '再整理一次'}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Radio.Group value={task} onChange={(e) => { setTask(e.target.value as AgentTask); setErr(null); }}>
              <Space direction="vertical" size="small">
                <Radio value="organize">
                  <strong>整理发音记录</strong>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                    {TASK_HINT.organize}
                  </Typography.Paragraph>
                </Radio>
                <Radio value="profile">
                  <strong>更新发音档案</strong>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                    {TASK_HINT.profile}
                  </Typography.Paragraph>
                </Radio>
                <Radio value="custom">
                  <strong>自定义</strong>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                    自己写一句要它做什么。它仍然只能动笔记和档案手写两节。
                  </Typography.Paragraph>
                </Radio>
              </Space>
            </Radio.Group>

            {task === 'custom' && (
              <Input.TextArea
                aria-label="自定义整理说明"
                value={note}
                rows={3}
                maxLength={2000}
                placeholder="比如：把 ɑ/æ 那篇笔记补上自检法和中文对照。"
                onChange={(e) => setNote(e.target.value)}
              />
            )}

            <Space wrap>
              <Button
                type="primary"
                disabled={running || (task === 'custom' && !note.trim())}
                onClick={() => setConfirmOpen(true)}
              >
                开始整理
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {running ? '上一次还在跑，等它结束或取消。' : '开始前会先让你确认一次能改什么、不能改什么。'}
              </Typography.Text>
            </Space>
          </Space>
        </Card>
      )}

      <Modal
        open={confirmOpen}
        title="开始整理？"
        okText="开始"
        cancelText="取消"
        confirmLoading={starting}
        onOk={() => void start()}
        onCancel={() => setConfirmOpen(false)}
      >
        <Space direction="vertical" size="middle">
          <Typography.Text>
            <strong>能改</strong>：本机笔记，以及当前用户档案的「已确认的习惯问题」「待观察」两节。
          </Typography.Text>
          <Typography.Text type="danger">
            <strong>不能改</strong>：词条、录音记录、复习进度、AUTO 统计块、随附笔记、代码。
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            跑完会列出改了哪些文件；不满意可以整批撤销。越界改动不会被撤销，只会被点名。
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  );
}
