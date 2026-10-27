import { useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import { api } from '../api';
import { checkModelAvailability, type ModelAvailability } from '../lib/asr';
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
export default function AsrStatus({ pollMs = DEFAULT_POLL_MS }: { pollMs?: number } = {}) {
  const [s, setS] = useState<AsrStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [modelState, setModelState] = useState<ModelAvailability>('checking');

  useEffect(() => {
    checkModelAvailability().then(setModelState).catch(() => setModelState('error'));
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      api.asrStatus().then((r) => {
        if (!alive) return;
        setS(r);
        if (r.state === 'starting' || r.state === 'off') timer = setTimeout(tick, pollMs);
      }).catch(() => { if (alive) timer = setTimeout(tick, pollMs); });
    };
    tick();
    return () => { alive = false; if (timer !== null) clearTimeout(timer); };
  }, [pollMs, reload]);

  const log = s ? (
    <details style={{ marginTop: 8 }}>
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
        } finally {
          setBusy(false);
        }
      }}
    >
      重启识别服务
    </Button>
  );

  if (!s || s.state === 'ready') {
    return s?.state === 'ready' && modelState === 'error'
      ? <Notice tone="quiet" title="备用识别模型检测失败">不影响音素级评测，只是主服务挂掉时没有退路。</Notice>
      : null;
  }

  if (s.state === 'starting') {
    return (
      <Notice tone="quiet" label="正在启动" title="音素识别服务正在准备，好了会自己变">
        首次使用要下约 1.2GB 模型；下面能看到它走到哪一步。
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
        也可以在下面点重启。
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
