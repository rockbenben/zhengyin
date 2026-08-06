import { useEffect, useState } from 'react';
import { Dropdown, Modal, Input, message } from 'antd';
import type { MenuProps } from 'antd';
import { api } from '../api';
import type { UserInfo } from '../types';

/**
 * 侧栏用户切换器。整机一个「当前用户」（服务端定），这里只是它的遥控器。
 * 服务连不上时整个不渲染——切换本来就切不动，摆一个死控件是骗人。
 * reload 可注入是给测试用的：jsdom 里 window.location.reload 不可替换。
 *
 * message 用静态导入而不是 AntApp.useApp()：这个仓库里所有组件（BackupSetting 等）
 * 都是这么用的，没有哪处套了 <App> Provider，跟 useApp() 不搭。
 */
export function UserSwitcher({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const [info, setInfo] = useState<UserInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => { api.user().then(setInfo).catch(() => setInfo(null)); }, []);
  if (!info) return null;

  const items: MenuProps['items'] = [
    ...info.users.map((u) => ({ key: u, label: u === info.current ? `${u}（当前）` : u })),
    { type: 'divider' as const },
    { key: '__add', label: '添加用户…' },
  ];

  async function onClick({ key }: { key: string }) {
    if (key === '__add') { setAdding(true); return; }
    if (key === info!.current) return;
    try {
      await api.switchUser(key);
      reload();                       // 换人 = 所有数据都变，整页刷新最稳
    } catch (e) {
      message.error(e instanceof Error ? e.message : '切换失败');
    }
  }

  async function create() {
    const n = name.trim();
    if (n === '') return;
    try {
      await api.createUser(n);
      await api.switchUser(n);        // 建完就切过去——按钮上就是这么写的
      reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '建不了');
    }
  }

  return (
    <>
      {/* ── 它属于版口，不属于刊头 ──
          换用户是**罕用动作**：绝大多数装机从头到尾只有一个人。给它一条独立的
          版带（更早还是个圆角药丸），等于让侧栏第二重的位置永远写着
          「谁在练：默认」——为一个不存在的选择立一个标签，正是这个仓库
          自己那条「标出例外，不标常态」反对的事。

          但也不能藏起来：换错了人，练出来的记录会全部落进别人的档案。
          版口正是它该待的地方——印刷车间的版口记的就是「谁在机上、印了几次、
          哪儿出的」，这三样是同一类信息。所以它跟印次、源码排在一起，
          用同一档等宽小字，只有指过去才亮起来。 */}
      <Dropdown menu={{ items, onClick: (i) => void onClick(i) }} trigger={['click']}>
        <button type="button" className="user-switch" aria-label={`当前用户 ${info.current}，点这里换人`}>
          在练 <b>{info.current}</b>
          <span className="caret" aria-hidden="true">▾</span>
        </button>
      </Dropdown>
      <Modal
        title="添加用户" open={adding} onOk={() => void create()}
        onCancel={() => setAdding(false)} okText="建好并切过去" cancelText="算了"
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字，比如：张三" />
      </Modal>
    </>
  );
}
