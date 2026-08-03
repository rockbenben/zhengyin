import { useState } from 'react';
import { Card, Radio, Space, Typography } from 'antd';
import { NS_KEY } from './Recorder';

/**
 * 采集设置：浏览器降噪开不开。
 *
 * 这是个**真的两面刃**，所以做成开关而不是替用户定死：
 * Chrome 的降噪是给语音通话调的，它压制的是"类噪声信号"——而擦音（/s/ /θ/ /ʃ/ /f/）
 * 本身就是噪声，正是这个工具最要分辨的那批音。安静环境下关掉往往更准；
 * 背景一直有响动时开着更稳。
 *
 * 另外两项（回声消除、自动增益）已经在 Recorder 里一律关掉，没有开关：
 * 这里没有远端声音要消；自动增益会动态改电平，把振幅包络一起改了，A/B 对比要的是原样。
 *
 * 存在 localStorage 而不是服务端 .env：它是这台机器上采集端的偏好，跟服务无关。
 */
export default function CaptureSetting() {
  const [off, setOff] = useState(() => localStorage.getItem(NS_KEY) === 'off');

  return (
    <Card title="录音采集">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, maxWidth: '60ch' }}>
          {'浏览器降噪是给通话调的，它压制"类噪声"——而 /s/ /θ/ /ʃ/ /f/ 这些擦音'}
          <strong>本身就是噪声</strong>{'，可能被一起削掉，偏偏那是评测最要分清的一批。'}
          {'哪个更好要看你的环境，用同一个词各录一次比比。'}
        </Typography.Paragraph>

        <Radio.Group
          value={off ? 'off' : 'on'}
          onChange={(e) => {
            const next = e.target.value === 'off';
            localStorage.setItem(NS_KEY, next ? 'off' : 'on');
            setOff(next);
          }}
        >
          <Space direction="vertical" size="small">
            <Radio value="on">
              <Typography.Text strong>开着降噪</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                背景一直有响动（空调、街声、风扇）时更稳。
              </Typography.Paragraph>
            </Radio>
            <Radio value="off">
              <Typography.Text strong>关掉降噪</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                安静环境下往往更准，擦音不会被削。录音里的底噪会照实留着。
              </Typography.Paragraph>
            </Radio>
          </Space>
        </Radio.Group>

        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          改完下一次录音生效。录完那一行会显示信噪比，可以直接拿它比较两种设置。
        </Typography.Text>
      </Space>
    </Card>
  );
}
