import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Alert, Button, Card, Input, Popconfirm, Space, Spin, Tag, Typography, message } from 'antd';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import { LoadFailed } from '../components/PageResult';
import { STOP_HINT } from '../lib/brand';
import type { MwKeyState, RuntimeInfo } from '../types';
import ModelSetting from '../components/ModelSetting';
import CaptureSetting from '../components/CaptureSetting';
import InkSetting from '../components/InkSetting';
import BackupSetting from '../components/BackupSetting';
import AiSettingsSection from '../components/AiSettingsSection';

const DESKTOP_HELP = (
  <Space direction="vertical" size={10} style={{ width: '100%' }}>
    <Typography.Text className="measure">
      <strong>关闭</strong>：关掉这个窗口就退出了，后台不会留进程。
    </Typography.Text>
    <Typography.Text className="measure">
      <strong>数据</strong>：菜单「文件 → 打开数据文件夹」能直接看到词条、练习记录、发音档案和本机笔记。
    </Typography.Text>
    <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
      要换一个数据文件夹：菜单「文件 → 更换数据文件夹…」，选完会重启。
    </Typography.Text>
  </Space>
);
// END DESKTOP_HELP

// 设置页：Merriam-Webster 词典 API key + 评测模型。
//
// 为什么值得做成页面而不是让人去改 .env：配不配这个 key 决定了你听到的是**真人录音**还是
// 合成音，而这正是发音练习里最要紧的差别。让用户为此去翻文档、找文件、还得重启服务，
// 门槛高得没必要。保存后立即生效（服务端只改内存里的那个字段，同时写进 .env 以便下次启动）。
export default function SettingsPage() {
  useTitle('设置');
  const [state, setState] = useState<MwKeyState | null>(null);
  const [loadError, setLoadError] = useState<null | 'offline' | 'failed'>(null);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    api.getMwKey().then(setState)
      .catch((e) => setLoadError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  useEffect(() => {
    api.runtime().then(setRuntime).catch(() => setRuntime(null));
  }, []);

  async function save(verify: boolean) {
    const key = input.trim();
    if (!key) { setErr('先把 key 填进去'); return; }
    setSaving(true);
    setErr(null);
    try {
      setState(await api.setMwKey(key, verify));
      setInput('');
      message.success('已保存并立即生效，不用重启');
    } catch (e) {
      // 服务端把校验失败的原因放在 error 里，直接透给用户——"key 无效"和"连不上词典服务"
      // 是两回事，前者要换 key，后者只是网络问题、可以跳过校验先存下。
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    try {
      setState(await api.clearMwKey());
      message.success('已清除，音频将回到合成语音');
    } catch {
      message.error('清除失败');
    }
  }

  // 设置页尤其不能只说「服务可能没启动」：人来这一页往往就是**为了**
  // 解决服务的问题，结果只得到一句陈述、没有下一步。
  if (loadError === 'offline') return <Offline />;
  // 这条原来是个 <Alert>，跟另外五页的 Result 长得不一样，文案却一字不差——
  // 因为不是 Result，上一轮清理五重复制时正好漏掉它。
  if (loadError) return <LoadFailed what="设置" />;
  if (!state) return <Spin style={{ marginTop: 48 }} />;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* H1 是页面名，跟侧栏那个导航项一字不差。原来这里印的是第一组卡的
          名字「词典与评测」——浏览器标签写着「设置 · 正音」、屏上最大的字却是
          「词典与评测」，后面五张卡（录音采集/备用模型/纸与墨/搬家）没有 H1 统领，
          读起来像这一页只讲词典。组名降到下面的组标。 */}
      <PageHead slug="设置" title="设置" meta="key 只存在这台机器上，不会进版本库" />

      <span className="slug">词典与评测</span>

      {/* ── 怎么开、怎么关 ──
             "找不到怎么开启、关闭这个服务"是真实会卡住人的一步，而人找的时候
             是在浏览器里、不在终端里——所以这段必须出现在页面上，光写在 README 里等于没写。

             两套文案按运行时分叉：浏览器模式讲三个启动器；桌面版没有黑窗口，
             讲关窗口即退出和原生菜单里的数据文件夹。
             仍然不做"网页上点一下关服务"的按钮：服务现在绑 127.0.0.1、自己管边车，
             关窗口/停止脚本已经能带走整棵进程树，再放一个按钮只会多一条容易误解的路径。 */}
      <Card title={runtime?.desktop ? '怎么退出 / 数据在哪' : '怎么开启 / 怎么关闭'} size="small">
        {runtime?.desktop ? DESKTOP_HELP : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text className="measure">
              <strong>开启</strong>：双击正音文件夹里的启动器（Windows 是{' '}
              <Typography.Text code>启动.cmd</Typography.Text>，macOS 是{' '}
              <Typography.Text code>启动.command</Typography.Text>，Linux 是{' '}
              <Typography.Text code>启动.sh</Typography.Text>）。
              {'浏览器会自己打开，不用记网址。'}
            </Typography.Text>
            <Typography.Text className="measure">
              <strong>关闭</strong>：把启动时弹出的那个黑窗口<strong>关掉</strong>就全停了。
              {'窗口找不着了的话，双击正音文件夹里的 停止.cmd（macOS 是 .command，Linux 是 .sh）——'}
              {'它按端口找进程，不会误杀别的程序。'}
            </Typography.Text>
            {/* 这里引的是**另一个界面上的原话**，而那种引用会烂：上一版引的是
                「TO STOP: just close this window」——那句英文早在启动器改说中文、
                停止提示挪进服务启动输出时就删掉了，全仓库一个字都不剩，而这一页
                还在原样引着它。下面 SettingsPage.test.tsx 盯着这条：引的话必须是
                服务真会打出来的那句。 */}
            <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
              {'练发音的时候那个黑窗口一直开着就行。服务起来时会在里面打一行「'}
              {STOP_HINT}
              {'」。'}
            </Typography.Text>
          </Space>
        )}
      </Card>

      <Card
        title={
          /* 得 wrap：Card 的标题栏 overflow:hidden，320px 下这一行放不下，
             「已配置 ••••847f」会被**切掉**——而那正是这张卡要回答的问题（配了没有）。 */
          <Space wrap>
            <span>Merriam-Webster 词典 API key</span>
            {state.configured
              ? <Tag color="success">已配置 {state.masked}</Tag>
              : <Tag>未配置</Tag>}
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" className="measure" style={{ marginBottom: 0 }}>
            配了它，单词页放的是 Merriam-Webster 的<strong>美音真人录音</strong>；不配也能用，
            {'会自动退到微软 edge-tts 合成语音，再退到浏览器本地朗读——但合成音的口型细节、'}
            {'连读和轻重音跟真人有差距，练发音时差别不小。'}
          </Typography.Paragraph>

          <div>
            <Typography.Text strong>怎么拿到（免费，两三分钟）</Typography.Text>
            <ol style={{ marginTop: 8, marginBottom: 0, paddingLeft: 22, lineHeight: 2 }}>
              <li>
                打开{' '}
                <Typography.Link href="https://dictionaryapi.com/register/index" target="_blank" rel="noreferrer">
                  dictionaryapi.com 注册页
                </Typography.Link>
                ，填邮箱注册（个人非商用免费）
              </li>
              <li>
                申请时<strong>产品选 “Collegiate Dictionary”</strong>——本工具用的是这个，
                {'选成 Thesaurus 之类的 key 在这里用不了'}
              </li>
              <li>登录后在 “Your Keys” 页面复制那串 key，粘贴到下面</li>
            </ol>
          </div>

          <Input.Password
            // 同首页：placeholder 不是名字。这个框叫什么只写在 Card 标题上，
            // 而那两者之间没有任何关联。
            aria-label="Merriam-Webster 词典 API key"
            placeholder={state.configured ? '要更换就粘贴新的 key' : '粘贴 key，形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
            value={input}
            onChange={(e) => { setInput(e.target.value); setErr(null); }}
            onPressEnter={() => void save(true)}
            // 同首页：默认那个 × 念出来是英文的「close-circle」
            allowClear={{ clearIcon: <span aria-label="清空">✕</span> }}
          />

          {err && (
            <Alert
              type="error"
              showIcon
              message={err}
              description={
                err.includes('连不上')
                  ? '如果只是暂时没网，可以点「跳过校验直接保存」，等有网时再验证。'
                  : undefined
              }
            />
          )}

          <Space wrap>
            <Button type="primary" loading={saving} onClick={() => void save(true)}>
              校验并保存
            </Button>
            <Button loading={saving} onClick={() => void save(false)}>
              跳过校验直接保存
            </Button>
            {state.configured && (
              <Popconfirm
                title="清除这个 key？"
                description="清除后音频会回到合成语音，已经下载过的真人录音不受影响"
                okText="清除"
                okType="danger"
                cancelText="取消"
                onConfirm={() => void clear()}
              >
                <Button danger>清除</Button>
              </Popconfirm>
            )}
          </Space>

          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            key 存在正音这个文件夹里的 <Typography.Text code>.env</Typography.Text> 里，只在这台机器上。
            {'这个页面只显示末 4 位，不回显完整内容。'}
          </Typography.Text>
        </Space>
      </Card>

      {/* AI 是单独一组：它决定的是「讲解谁来写」，跟上面的词典/评测不是一回事。
          不配也不影响查词、发音和评测——这段承诺写在这张卡自己的开头。 */}
      <span className="slug">AI 讲解</span>
      <AiSettingsSection />

      <CaptureSetting />

      <ModelSetting />

      <InkSetting />

      <BackupSetting />
    </Space>
  );
}
