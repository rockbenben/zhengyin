import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Alert, Button, Card, Input, Popconfirm, Segmented, Space, Spin, Tag, Typography, message } from 'antd';
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
import DesktopPanel from '../components/DesktopPanel';

const DESKTOP_HELP = (
  <Space direction="vertical" size={10} style={{ width: '100%' }}>
    <Typography.Text className="measure">
      <strong>关闭</strong>：关掉这个窗口就退出了，后台不会留进程。
    </Typography.Text>
    <Typography.Text className="measure">
      <strong>数据</strong>：下面「桌面版」那一段里有「打开数据文件夹」，能直接看到词条、练习记录、发音档案和本机笔记。
    </Typography.Text>
    <Typography.Text type="secondary" className="measure" style={{ fontSize: 13 }}>
      要换一个数据文件夹：同一处的「更换数据文件夹…」，选完会重启。
    </Typography.Text>
  </Space>
);
// END DESKTOP_HELP

/**
 * 设置页的分组。
 *
 * 原来这一页是**八张等权的卡竖着排**：词典 key、AI、降噪、备用模型、纸与墨、搬家，
 * 外加两张桌面版的。实测 3317px——2.7 屏，56 个可聚焦控件，**零分组**。
 * 「设置界面过于复杂」说的不是哪一张卡复杂，是**八件事同时摊开**，
 * 而且每一件看起来一样重，于是找不到自己那一件在哪（找「数据文件夹在哪」的人
 * 只会先看见词典 key）。
 *
 * 所以按「你为什么来设置」分成五组，一组一次只露几件：
 *   应用   —— 这个应用本身：怎么退出、数据在哪、有没有新版本
 *   声音   —— 你录进来的声音：真人发音、降噪、识别服务没起来时的退路
 *   AI 讲解 —— 讲解由谁来写
 *   主题   —— 深浅纸与第二版的颜色
 *   搬家   —— 练习记录导出与导入
 *
 * 分组名要说清**它是什么**：主题、声音、搬家、AI 讲解。
 * 那张卡原来叫「纸与墨」——那是卡里那套印刷隐喻的名字，不是设置项的名字：
 * 在设置页里找「主题」的人，看不出「纸与墨」就是它。
 */
type SettingsGroup = 'app' | 'sound' | 'ai' | 'ink' | 'move';

const GROUPS: Array<{ key: SettingsGroup; label: string; hint: string }> = [
  { key: 'app', label: '应用', hint: '这个应用本身：怎么退出、数据在哪、有没有新版本。' },
  { key: 'sound', label: '声音', hint: '你录进来的声音：真人发音、录音降噪、识别服务没起来时的退路。' },
  { key: 'ai', label: 'AI 讲解', hint: '讲解由谁来写。不接也能用查词、真人发音、逐音素评测和复习。' },
  { key: 'ink', label: '主题', hint: '深浅纸和第二版的颜色。只记在这台机器上，不上传。' },
  { key: 'move', label: '搬家', hint: '练习记录导出与导入：换电脑时用。' },
];

// 词典 key 这张卡：为什么值得做成页面而不是让人去改 .env ——
// 配不配这个 key 决定了你听到的是**真人录音**还是
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
  const [group, setGroup] = useState<SettingsGroup>('app');

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

  const current = GROUPS.find((g) => g.key === group) ?? GROUPS[0];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* H1 是页面名，跟侧栏那个导航项一字不差。原来这里印的是第一组卡的
          名字「词典与评测」——浏览器标签写着「设置 · 正音」、屏上最大的字却是
          「词典与评测」，后面几张卡（录音采集/备用模型/主题/搬家）没有 H1 统领，
          读起来像这一页只讲词典。现在组名归下面的切换器（每组自己带一句说明）。 */}
      <PageHead slug="设置" title="设置" meta="这里只放需要你做选择的事，其余跟着应用走" />

      {/* ── 分组切换 ──
          这一行是整页的**入口**：八件事同时摊开的时候，没有一件能被别人看见。
          antd 的 Segmented 是 radiogroup，方向键能走，读屏也知道它是「一组选项」。
          每组下面那一句说明，说的就是「这一组管什么」——原来八张等权的卡，
          谁也不知道哪张卡对应自己的问题。

          **不用 `block`**：它强制五项等宽，于是 320px 下每项只剩 56px，
          「AI 讲解」「主题」被切掉（实测）。按内容排的话五项约 280px，320px 装得下，
          窄屏也不用把组名缩成两个字。 */}
      <Segmented
        aria-label="设置分组"
        value={group}
        onChange={(v) => setGroup(v as SettingsGroup)}
        options={GROUPS.map((g) => ({ label: g.label, value: g.key }))}
      />
      <Typography.Text type="secondary" className="measure" style={{ fontSize: 13, marginTop: -10 }}>
        {current.hint}
      </Typography.Text>

      {group === 'app' && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* ── 怎么开、怎么关 ──
                 "找不到怎么开启、关闭这个服务"是真实会卡住人的一步，而人找的时候
                 是在浏览器里、不在终端里——所以这段必须出现在页面上，光写在 README 里等于没写。

                 两套文案按运行时分叉：浏览器模式讲三个启动器；桌面版没有黑窗口，
                 讲关窗口即退出和这一页里的「桌面版」一段。
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
                  {'它根据当前文件夹的运行记录停止正音，自定义端口也能用。'}
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

          {/* 桌面版的那一段**紧跟在这张卡后面**，不是排在整页最底下。
              原来它挂在最后（这一页有六七张卡、词典/AI/录音/模型/纸墨/搬家），而
              「数据文件夹在哪、怎么换」正是刚问「怎么设置」的人要找的东西——
              埋在一页的最底下，等于没有。原来菜单里它藏在「文件」子菜单的第三项，
              一样是那种「其实有、但没人找得到」的位置。 */}
          <DesktopPanel />
        </Space>
      )}

      {group === 'sound' && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
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

              {/* 「怎么拿到」那三步收起来：它只对**第一次**配 key 的人有用，
                  而它自己占掉这张卡的一半高度（实测 434px 里约 200px）。
                  摘要行写明「免费，两三分钟」，要的人一眼看得见要点开。 */}
              <details>
                <summary className="slug" style={{ color: 'var(--blue)', cursor: 'pointer' }}>
                  怎么拿到 key（免费，两三分钟）
                </summary>
                <ol style={{ marginTop: 8, marginBottom: 0, paddingLeft: 22, lineHeight: 2 }}>
                  <li>
                    打开{' '}
                    <Typography.Link href="https://dictionaryapi.com/register/index" target="_blank" rel="noreferrer">
                      dictionaryapi.com 注册页
                    </Typography.Link>
                    ，填邮箱注册（个人非商用免费）
                  </li>
                  <li>
                    申请时<strong>产品选「Collegiate Dictionary」</strong>——本工具用的是这个，
                    {'选成 Thesaurus 之类的 key 在这里用不了'}
                  </li>
                  <li>
                    登录后打开{' '}
                    <Typography.Link href="https://dictionaryapi.com/account/my-keys" target="_blank" rel="noreferrer">
                      My Keys
                    </Typography.Link>
                    {' '}页面复制那串 key，粘贴到下面；已经注册过的人不用重新注册
                  </li>
                </ol>
              </details>

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

          <CaptureSetting />

          <ModelSetting />
        </Space>
      )}

      {group === 'ai' && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* AI 是单独一组：它决定的是「讲解谁来写」，跟词典/评测不是一回事。
              不配也不影响查词、发音和评测——这段承诺写在这张卡自己的开头。 */}
          <AiSettingsSection />
        </Space>
      )}

      {group === 'ink' && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <InkSetting />
        </Space>
      )}

      {group === 'move' && (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <BackupSetting />
        </Space>
      )}
    </Space>
  );
}
