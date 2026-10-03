import { useState } from 'react';
import { Button, message } from 'antd';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import { api } from '../api';

/**
 * 收藏 = 手动把一个词塞进复习队列。
 *
 * 复习队列平时由证据驱动：录音真发错了才进来。但模型测不出的东西你自己知道——
 * 某个词念着就是别扭、或者刚讲完想多练几遍。这个按钮就是那条人工通道。
 *
 * 收藏的卡片**不会自动毕业**（普通卡片爬到最高一级答对一次就出列），
 * 因为那是你主动要留的，工具不该替你决定它练够了。
 */
export default function StarButton({ text, starred, onChange }: {
  text: string;
  starred: boolean;
  onChange: (starred: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      const r = await api.star(text, !starred);
      onChange(r.starred);
      // 提示语必须跟按钮**同一个词**：按钮写「移出复习」，这里就不能冒出
      // 一句「已取消收藏」。「收藏」在这个应用里根本不存在，是凭空多出来的
      // 第三个说法——按了「移出复习」却被告知「取消收藏」，人会以为点错了。
      // 加进来的卡从**第二天**算起（review.ts 的 addCard），当场去复习页是空的。
      // 只说「已加入复习」等于让人白跑一趟，所以把到期时间一起说了。
      message.success(r.starred ? '已加入复习，明天到期' : '已移出复习');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      loading={busy}
      icon={starred ? <StarFilled /> : <StarOutlined />}
      onClick={() => void toggle()}
      style={starred ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : undefined}
    >
      {/* 「在复习队列里」是状态不是动作——点下去会发生什么，它没说。
          实心星已经表达了状态，文字负责说清这一下的后果。 */}
      {starred ? '移出复习' : '加入复习'}
    </Button>
  );
}
