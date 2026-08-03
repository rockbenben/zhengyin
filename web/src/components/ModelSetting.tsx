import { useEffect, useState } from 'react';
import { Alert, Card, Radio, Space, Spin, Tag, Typography, message } from 'antd';
import { api } from '../api';
import { resetModel } from '../lib/asr';
import type { ModelState } from '../types';

// 【备用】评测模型的选择。
//
// 注意这不是主路径：主路径是本机的音素识别服务（asr-service），它不受词表约束、
// 能说出你实际发的是什么音。这里的浏览器模型只在那个服务没启动时才用，而且只能在
// 给定的几个易混词里挑一个。这段说明以前把它写成了主路径，是改造前的遗留。
//
// 为什么还要能换：小模型（39MB）对 l/n、θ/s 这类难点判别力很弱，两个候选都给"接受"。
// 大模型（125MB）声学模型换了一代，能拉开差距，但下载慢、内存占用高。
//
// 换完必须 resetModel()：模块里缓存着已加载的 Model 和探测结果，不清掉的话页面不刷新
// 就还在用旧模型，而界面已经显示换好了——比不能换更糟。
export default function ModelSetting() {
  const [state, setState] = useState<ModelState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getModel().then(setState).catch(() => setLoadError(true));
  }, []);

  async function pick(id: string) {
    setSaving(true);
    try {
      const next = await api.setModel(id);
      setState(next);
      resetModel();
      const opt = next.options.find((o) => o.id === next.selected);
      message.success(opt?.downloaded ? '已切换，下次评测即生效' : '已切换，但这个模型还没下载');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '切换失败');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <Alert type="error" showIcon message="读取模型设置失败" />;
  if (!state) return <Card><Spin /></Card>;

  const current = state.options.find((o) => o.id === state.selected);

  return (
    <Card title="备用评测模型（浏览器本地）">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {/* **不在这儿摆 `npm run asr`。** 双击启动的人从不开终端，而 `npm start`
              本来就带着那个服务——单跑它一样起不来（缺的多半是 uv）。
              「怎么把它开起来」由录音区那几条 Notice 一处说，那儿说得对也说得全。
              同一个理由在 Verdicts 里删过一次。 */}
          <strong>这是退路，不是主力。</strong>平时评测走的是本机的音素识别服务，
          {'它能说出你实际发的是什么音。'}
          {'只有那个服务没启动时才退到这里的浏览器模型——它只能在几个易混词里挑一个，'}
          {'说不出你实际发了什么。录音都不上传、不落盘。'}
        </Typography.Paragraph>

        <Radio.Group
          value={state.selected}
          disabled={saving}
          onChange={(e) => void pick(e.target.value as string)}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {/* 圆点跟标题对齐由 styles.css 的 .ant-radio 那条管——
                在 <Radio> 上写 alignItems 无效（子元素的 align-self 压过父级），
                那条 CSS 上面的注释里有实测。 */}
            {state.options.map((o) => (
              <Radio key={o.id} value={o.id}>
                <Space size="small" wrap>
                  <Typography.Text strong>{o.label}</Typography.Text>
                  {o.downloaded ? <Tag color="success">已下载</Tag> : <Tag>未下载</Tag>}
                </Space>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                  {o.note}
                </Typography.Paragraph>
              </Radio>
            ))}
          </Space>
        </Radio.Group>

        {current && !current.downloaded && (
          <Alert
            type="warning"
            showIcon
            message={`${current.label} 还没下到本地`}
            description={
              <>
                {/* 这条命令**必须留着**：下模型没有双击的替代路径，删了就没有出路了。
                    但「仓库根目录」是开发者的说法——照做的人得知道在哪儿打开终端。 */}
                在正音这个文件夹里打开终端，跑这条命令下载（{current.sizeMb}MB，只需一次）：
                <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
                  <Typography.Text code copyable>{`npm run fetch-model -- ${current.id}`}</Typography.Text>
                </Typography.Paragraph>
              </>
            }
          />
        )}
      </Space>
    </Card>
  );
}
