import { useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import { api } from '../api';
import { checkModelAvailability, type ModelAvailability } from '../lib/asr';
import { asrStartupLabel, asrStartupPollMs } from '../lib/asrStartup';
import type { AsrStatusInfo } from '../types';
import Notice from './Notice';

const DEFAULT_POLL_MS = 2000;

/**
 * 识别服务的状态条。**页面级，一页一份。**
 *
 * 它现在读的是服务端的管理状态（/api/asr/status），不再靠“连不上就猜”。
 * 第一屏就能看到边车进行到哪一步、最近几行日志，以及一颗重启按钮——
 * 桌面版没有那个“启动时打开的黑窗口”，不能让人回终端里找。
 */
export default function AsrStatus({ pollMs, compact = false }: { pollMs?: number; compact?: boolean } = {}) {
  const [s, setS] = useState<AsrStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [modelState, setModelState] = useState<ModelAvailability>('checking');

  useEffect(() => {
    if (compact) return;
    checkModelAvailability().then(setModelState).catch(() => setModelState('error'));
  }, [compact]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      api.asrStatus().then((r) => {
        if (!alive) return;
        setS(r);
        setStatusError(null);
        // 就绪后仍要发现进程退出。启动中频繁更新，其他状态降低轮询频率。
        const delay = r.state === 'starting' ? pollMs ?? asrStartupPollMs(r) : Math.max(pollMs ?? DEFAULT_POLL_MS, 5000);
        timer = setTimeout(tick, delay);
      }).catch(() => {
        if (!alive) return;
        setStatusError('暂时无法获取识别服务状态，请确认正音的后台服务仍在运行。');
        timer = setTimeout(tick, pollMs ?? DEFAULT_POLL_MS);
      });
    };
    tick();
    return () => { alive = false; if (timer !== null) clearTimeout(timer); };
  }, [pollMs, reload]);

  const log = s ? (
    <details key={s.state} open={s.state === 'error' || undefined} style={{ marginTop: 8 }}>
      <summary>识别服务日志（最近 {s.log.length} 行）</summary>
      <pre className="mono-note" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {s.log.join('\n')}
      </pre>
    </details>
  ) : null;

  const restart = (
    <Button
      size="small"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          setS(await api.asrRestart());
          setReload((n) => n + 1);
        } catch {
          setStatusError('未能重启识别服务，请确认正音的后台服务仍在运行。');
        } finally {
          setBusy(false);
        }
      }}
    >
      重启识别服务
    </Button>
  );

  if (statusError) return <Notice tone="warn" title={statusError}>{restart}</Notice>;

  if (!s || s.state === 'ready') {
    return !compact && s?.state === 'ready' && modelState === 'error'
      ? <Notice tone="quiet" title="备用识别模型检测失败">不影响音素级评测，只是主服务挂掉时没有退路。</Notice>
      : null;
  }

  if (s.state === 'starting') {
    if (compact && !s.stalled) {
      return <Typography.Text type="secondary" role="status">{asrStartupLabel(s)}</Typography.Text>;
    }
    return (
      <Notice tone={s.stalled ? 'warn' : 'quiet'} title={asrStartupLabel(s)}>
        {s.stalled
          ? '已超过 2 分钟没有收到新进度。可以查看日志、检查网络或磁盘空间，也可以重启识别服务。'
          : s.stage === 'dependencies'
            ? '首次使用需要下载并安装 Python 依赖。安装完成后会开始加载模型。'
            : s.stage === 'model' ? '首次使用可能需要下载约 1.2GB 的模型。' : null}
        {log}
        {restart}
      </Notice>
    );
  }

  if (s.state === 'no-uv') {
    return (
      <Notice tone="quiet" label="逐音素评测没开" title="这台机器没有可用的 uv">
        桌面版安装包应自带 uv，没有的话多半是安装不完整，重新安装一次。浏览器模式装一个：
        <Typography.Text code>pip install uv</Typography.Text> ·{' '}
        <Typography.Text code>winget install astral-sh.uv</Typography.Text> ·{' '}
        <Typography.Text code>brew install uv</Typography.Text>，然后重启服务。
        <strong>在那之前查词、真人发音、录音、A/B 对比都照常用。</strong>
        {log}
        {restart}
      </Notice>
    );
  }

  if (s.state === 'off') {
    return (
      <Notice tone="quiet" label="逐音素评测没开" title="识别服务没有由主服务托管">
        开发模式下由 <Typography.Text code>npm run asr</Typography.Text> 单独启动；
        {'也可以在下面点重启。'}
        {log}
        {restart}
      </Notice>
    );
  }

  return (
    <Notice tone="warn" label="逐音素评测没开" title="识别服务出错了">
      {s.error ?? '原因不明。'}
      {log}
      {restart}
    </Notice>
  );
}
