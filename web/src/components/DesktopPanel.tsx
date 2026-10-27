import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Space, Typography, message } from 'antd';
import { desktopBridge, type DesktopState, type UpdateState } from '../lib/desktop';

/**
 * 设置页里的「桌面版」一段。
 *
 * **它顶的是原来那条菜单栏。** Electron 的「文件 / 帮助」撤掉之后，打开数据文件夹、
 * 换数据文件夹、检查更新、退出这些动作改由这里摆——菜单里有的这里都得有，
 * 少一个就等于悄悄少给了功能。
 *
 * 浏览器模式里这个组件什么都不渲染：那些动作在浏览器里没有对应物，
 * 摆一组点不动的按钮比不摆更糟。
 */
export default function DesktopPanel() {
  const bridge = desktopBridge();
  const [state, setState] = useState<DesktopState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const prevUpdateState = useRef<UpdateState | null>(null);

  const refresh = useCallback(() => {
    bridge?.state()
      .then((s) => { setState(s); setStateError(null); })
      .catch((e: unknown) => {
        // 读不到状态**不是**「没有更新器」：那会把整块更新区和开发者工具按钮
        // 悄悄收走，用户分不清「这台机器没有更新」和「桥坏了」。说出来。
        setStateError(e instanceof Error ? e.message : '读不到桌面外壳的状态');
      });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    refresh();
    // 更新是**后台**下好的：下好那一刻页面不会自己变。
    // 每三秒问一次主进程（本地 IPC，不走网络），那一条「重启以完成更新」自己就冒出来。
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [bridge, refresh]);

  /**
   * 「已经是最新了」只在**刚查完**的那一刻说一次。
   *
   * 之前点完「检查更新」界面上一动不动：没有新版时更新器只是回到 idle，
   * 那个状态没人读，于是用户分不清"没反应"和"没有新版"。
   */
  useEffect(() => {
    const now = state?.updateState ?? null;
    const prev = prevUpdateState.current;
    prevUpdateState.current = now;
    if (prev === 'checking' && now === 'idle') message.info('已经是最新版本了');
  }, [state]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '没做成');
    }
    refresh();
  };

  if (!bridge) return null;

  return (
    <Card title="桌面版" size="small">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {stateError && (
          <Alert type="warning" showIcon message="读不到桌面外壳的状态" description={stateError} />
        )}

        {/* 这段只说「这些动作原来在菜单栏上，现在在这儿」。
            **不重复上面那张卡的话**（「能直接看到词条、练习记录…」那句）——
            两张卡紧挨着，同一句话连着说两遍，读着像出了两次错。 */}
        <Typography.Text className="measure">
          {'原来那条菜单栏（已撤）上的动作，现在都在这儿。'}
        </Typography.Text>

        <Space wrap>
          <Button onClick={() => void run(() => bridge.openDataFolder())}>打开数据文件夹</Button>
          <Button onClick={() => void run(() => bridge.changeDataFolder())}>更换数据文件夹…</Button>
        </Space>

        {/* 更新的那几项**只有 NSIS 安装版有**（zip 免安装版没有可覆盖的安装根），
            摆出来就得是能用的——所以先问主进程有没有更新器再摆。 */}
        {state?.updater && (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <span className="slug">更新</span>
            <Space wrap align="center">
              <Button
                loading={state.updateState === 'checking'}
                onClick={() => void run(() => bridge.checkUpdate())}
              >
                检查更新
              </Button>
              <Checkbox
                checked={state.autoCheck}
                onChange={(e) => void run(() => bridge.setAutoCheck(e.target.checked))}
              >
                自动检查更新
              </Checkbox>
            </Space>
            {state.updateState === 'downloading' && (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                正在下载新版本……
              </Typography.Text>
            )}
            {state.updateReady && (
              <Alert
                type="success"
                showIcon
                message={`新版本 v${state.updateReady} 已经下好了`}
                description="重启就能装上。正在录的话，录完再重启。"
                action={(
                  <Button type="primary" onClick={() => void run(() => bridge.restartToUpdate())}>
                    重启以完成更新
                  </Button>
                )}
              />
            )}
          </Space>
        )}

        <span className="slug">应用</span>
        <Space wrap>
          <Button onClick={() => void run(() => bridge.reload())}>重新加载</Button>
          <Button onClick={() => void run(() => bridge.about())}>关于正音</Button>
          <Button onClick={() => void run(() => bridge.quit())}>退出</Button>
          {state?.devTools && (
            <Button onClick={() => void run(() => bridge.devTools())}>开发者工具</Button>
          )}
        </Space>

        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          正音 {state?.version ?? '—'}。数据全部在这台机器上，关掉这个窗口就退出了。
        </Typography.Text>
      </Space>
    </Card>
  );
}
