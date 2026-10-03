import { useEffect, useState } from 'react';
import { Typography } from 'antd';
import { api } from '../api';
import { checkModelAvailability, type ModelAvailability } from '../lib/asr';
import Notice from './Notice';

const DEFAULT_POLL_MS = 2000;
const DEFAULT_GIVE_UP_MS = 90_000;

/**
 * 识别服务的状态条。**页面级，一页一份。**
 *
 * 原来这几条长在 Recorder 里，而词条页是**逐音节**各摆一个 Recorder——
 * 于是「音素识别服务正在加载模型」这种整页一模一样的三行字，两个音节就整份
 * 重复两遍（90 秒后的升级态同样 ×2）。它说的是这台机器的状态，
 * 不是每个音节的状态，所以搬到这里，由页面挂一次。
 *
 * 四档状态与轮询的理由原样搬自 Recorder（GIVE_UP 之前不许说"没启动"——
 * 它正在启动；uv 缺失要立刻说，不让人空等 90 秒）。
 * pollMs / giveUpMs 是测试缝：90 秒的分支不该在测试里真等 90 秒。
 */
export default function AsrStatus({
  pollMs = DEFAULT_POLL_MS,
  giveUpMs = DEFAULT_GIVE_UP_MS,
}: { pollMs?: number; giveUpMs?: number } = {}) {
  const [sidecar, setSidecar] = useState<'checking' | 'starting' | 'up' | 'down' | 'no-uv'>('checking');
  const [modelState, setModelState] = useState<ModelAvailability>('checking');

  useEffect(() => {
    checkModelAvailability().then(setModelState).catch(() => setModelState('error'));
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();

    const ask = () => {
      api.pronounceHealth()
        .then((r) => {
          if (!alive) return;
          if (r.ok) { setSidecar('up'); return; }
          // **只认明确的 false**：字段缺失时不许断言"你没装 uv"（理由见 Recorder 原注释）
          if (r.uv === false) { setSidecar('no-uv'); return; }
          again();
        })
        .catch(() => { if (alive) again(); });
    };
    const again = () => {
      setSidecar(Date.now() - started > giveUpMs ? 'down' : 'starting');
      if (Date.now() - started > giveUpMs) return;
      timer = setTimeout(ask, pollMs);
    };

    ask();
    return () => { alive = false; if (timer !== null) clearTimeout(timer); };
  }, [pollMs, giveUpMs]);

  return (
    <>
      {/* 浏览器是主服务一绑上端口就打开的，而边车还要十几秒加载模型——这十几秒里
             说"没启动"跟事实相反。这一档会自己转成下面的结果，不用手动刷新。 */}
      {sidecar === 'starting' && (
        <Notice tone="quiet" label="正在启动" title="音素识别服务正在加载模型，稍等十几秒">
          模型还在读进内存，<strong>好了会自己变，不用刷新页面</strong>。
          {'这段时间录音和对比播放照常用，只是还测不出「第几个音发成了什么」。'}
        </Notice>
      )}

      {/* 没装 uv：立刻说，并且**在浏览器里**就给出装法。
             不叫人去翻终端——双击启动的人可能根本没有那个窗口。 */}
      {sidecar === 'no-uv' && (
        <Notice tone="quiet" label="逐音素评测没开" title="这台机器还没装 uv，装上就能用">
          <>
            「你第几个音发成了什么」这一项要一个本机的 Python 服务，它由
            <Typography.Text code>uv</Typography.Text> 拉起来，而这台机器上还没有 uv。
            <br />
            装法（三选一）：<Typography.Text code>pip install uv</Typography.Text> ·
            {' '}<Typography.Text code>winget install astral-sh.uv</Typography.Text> ·
            {' '}<Typography.Text code>brew install uv</Typography.Text>
            <br />
            装完重新双击启动那个文件即可（首次会下约 1.2GB 模型）。
            <strong>在那之前查词、真人发音、录音、A/B 对比都照常用</strong>，
            {'只是测不出「第几个音发成了什么」。'}
          </>
        </Notice>
      )}
      {/* 标题只说观察到的事（还没连上），不能断言"没起来"——模型在 uvicorn 的 startup
             事件里加载，加载完之前端口不接受连接，所以"还没装"和"正在下 1.2GB"
             在浏览器这一侧一模一样，都是连接被拒。第一次启动最容易越过这里的 90 秒
             （建 venv 装依赖实测 71 秒，再加下模型），而那时候它一切正常。
             措辞用「黑窗口」不用「终端窗口」：走到这一档的人多半是双击启动的，
             本来就是为了不碰终端（uv 分支的测试早就为同样的理由钉过一条）。 */}
      {sidecar === 'down' && (
        <Notice tone="warn" label="逐音素评测没开" title="等了一分半还没连上">
          {(
            <>
              <strong>看一眼启动时打开的那个黑窗口</strong>，里面有一行
              <Typography.Text code>[asr]</Typography.Text> 开头的说明——首次启动多半是还在下模型
              {'（约 1.2GB，那里有进度条），缺 uv 的话那里会直接给出装法。'}
              {modelState === 'available'
                ? ' 这期间会退到一个更弱的办法：在两个相近的词里挑一个，说不出你实际发的是什么音。'
                : ' 在那之前录音和 A/B 对比照常用，只是测不出「第几个音发成了什么」。'}
            </>
          )}
        </Notice>
      )}
      {sidecar === 'up' && modelState === 'error' && (
        <Notice tone="quiet" title="备用识别模型检测失败">
          不影响音素级评测，只是主服务挂掉时没有退路。
        </Notice>
      )}
    </>
  );
}
