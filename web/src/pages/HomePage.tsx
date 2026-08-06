import { useCallback, useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { APP_NAME } from '../lib/brand';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, Input, Popconfirm, Space, Spin, Table, Typography, message } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import PageHead from '../components/PageHead';
import { LoadFailed } from '../components/PageResult';
import Notice from '../components/Notice';
import HowItWorks from '../components/HowItWorks';
import TodayPlan from '../components/TodayPlan';
import type { EntryListItem } from '../types';

// localStorage 键名：关掉「还没配真人发音」这条提示后不再弹
const MW_ALERT_DISMISSED = 'pron:mw-alert-dismissed';

/**
 * 空库时的起步词。
 *
 * 冷启动最卡人的一步是「先查一个词」——**查哪个？** 他不知道自己哪些音有问题，
 * 而那恰恰是他来用这个工具的原因。让人凭空想一个英文单词，等于把第一道门焊死。
 *
 * 这六个词不是随便挑的：一条对一条盖住 美音要点-中文母语者.md 的六项，
 * 也就是中文母语者统计上最容易错的地方，按「影响听懂的程度」排。
 * 点一下就建词条——音标、真人录音、音素条、评测全自动配好，直接能开录。
 */
const STARTERS: Array<{ word: string; why: string }> = [
  { word: 'desk', why: '音节尾的辅音，别念成「代斯克」' },
  { word: 'seat', why: '长短元音是两个音，跟 sit 不一样' },
  { word: 'thin', why: 'θ——中文里没有这个音' },
  { word: 'comfortable', why: '重音位置，比音素错更难懂' },
  { word: 'about', why: '弱读的 ə，越轻越对' },
  { word: 'light', why: 'l / n 不分' },
];

// 首页＝查询历史：只列出已经落地到服务端的词条，搜索只在这些已存条目里前端过滤
// （entries.filter(e => e.text.includes(kw))）。这个页面从不生成新讲解，搜不到东西
// 时明确告诉用户去问 AI，不能让人以为这里能现查新词。
export default function HomePage() {
  useTitle('查词');
  const [entries, setEntries] = useState<EntryListItem[] | null>(null);
  const [error, setError] = useState<null | 'failed' | 'offline'>(null);
  const [mwConfigured, setMwConfigured] = useState<boolean | null>(null);
  // 「怎么用」按**录过音没有**收起来，不按查过几个词——判据的理由见 HowItWorks 里那段。
  // null = 还没取回来，那时先不渲染它，免得闪一下再消失。
  const [attempts, setAttempts] = useState<number | null>(null);
  // 关掉之后就永久不再弹。这不是错误、只是"音频质量可以更好"的提示，知道了就没必要
  // 每次开页都被拦一次；真想再看，设置页里一直有当前状态。
  const [alertDismissed, setAlertDismissed] = useState(
    () => localStorage.getItem(MW_ALERT_DISMISSED) === '1',
  );
  const [kw, setKw] = useState('');
  const [adding, setAdding] = useState(false);

  const navigate = useNavigate();

  const load = useCallback(() => {
    api.listEntries().then((d) => setEntries(d.entries))
      .catch((e) => setError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  /**
   * 直接建词条。词典查不到的词服务端会返回 400，如实说出来，不假装成功。
   * @param raw 不传就用输入框里的内容；起步词按钮传它自己那个词。
   */
  const lookUp = useCallback(async (raw?: string) => {
    const text = (raw ?? kw).trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      // ── 先问一句：这是一个**音**吗？ ──
      //
      // 打 θ 或 ɑ 进来的人想看的是"这个音怎么发"，而不是建一个词条。
      // 原来一律走建词条：CMUdict 查不到 → 词条被删掉 → 弹一句
      // 「词典里没有「θ」，检查一下拼写。专有名词和缩写要手工给音标」。
      // **给一个念音的人的却是拼写建议**，而他要的东西这个应用其实早就有了：
      // 41 个音素每个都有「怎么发」（舌尖顶哪、气流走哪），一句都不用问 AI。
      //
      // 不在前端存一份音素表：直接问服务端，404 就说明不是音素。
      // 存一份的话它迟早跟 phones.ts 漂移，而那种漂移是无声的。
      if (text.length <= 3) {
        try {
          await api.phoneme(text);
          navigate(`/phoneme/${encodeURIComponent(text)}`);
          setKw('');
          return;
        } catch {
          // 不是音素，照常往下走建词条那条路
        }
      }
      const d = await api.addEntry(text);
      // 词典里一个词都查不到（打错字、生造词）：服务端照样建了词条，但那个词条上
      // 音标、音素条、评测全都没有，留着只是往库里堆垃圾。删掉并说清楚。
      // 注意只在**全都**查不到时才删——短语里一个词查不到、其余能查到的仍然有用。
      if (d.words.length > 0 && d.words.every((w) => !w.found)) {
        await api.deleteEntry(d.text).catch(() => {});
        message.warning(`词典里没有「${d.text}」，检查一下拼写。专有名词和缩写得手工给音标，让 AI 帮你录`);
        return;
      }
      load();
      setKw('');
      navigate(`/word/${encodeURIComponent(d.text)}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '没能加上这个词');
    } finally {
      setAdding(false);
    }
  }, [kw, adding, load, navigate]);

  useEffect(() => {
    load();
    api.health().then((h) => setMwConfigured(h.mwConfigured)).catch(() => {});
    // 取不到就当成 0：宁可多给一次说明，也不要让第一次用的人对着空页面没话看
    api.stats().then((s) => setAttempts(s.overall.attempts)).catch(() => setAttempts(0));
  }, [load]);

  // 连不上 和 服务在跑但这次失败了，是两件事：前者要人去把服务起起来，
  // 后者刷新就可能好。给同一屏的话，第二种情况会让人白跑一趟去重启。
  if (error === 'offline') return <Offline />;
  if (error) return <LoadFailed what="单词列表" />;
  if (!entries) return <Spin style={{ marginTop: 48 }} />;

  const filtered = kw ? entries.filter((e) => e.text.includes(kw)) : entries;

  const columns: TableColumnsType<EntryListItem> = [
    {
      title: '单词',
      dataIndex: 'text',
      key: 'text',
      render: (text: string) => <Link to={`/word/${encodeURIComponent(text)}`}>{text}</Link>,
    },
    {
      // 表头说「音标」不说「IPA」：应用其余地方（README、词条页、设置页）
      // 一律叫音标，只有这一列冒出来一个英文缩写。
      title: '音标',
      dataIndex: 'ipa',
      key: 'ipa',
      // 窄屏也收起来。上一轮只收了「更新时间」和「发音」，剩下的四列在 390px 下
      // **还是挤**：音标最宽（`/ˈdoʊpəˌmin ˈdiˌtɑks/` 一条就 150px），
      // 挤出来的结果是「讲解」表头竖成一个「解」、「删除」竖成「删／除」两行——
      // 正是上一轮想治的那个样子。
      // 收音标不收「操作」：音标点进词条页第一屏就有，而删词条在手机上收掉就没有别处能做了。
      responsive: ['sm'],
      render: (ipa: string) => (ipa ? `/${ipa}/` : <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      // 窄屏收起来：390px 下六列一起挤，这一列（最宽、也最不用看）被压到 55px、
      // 表头「更新时间」折成三行，其余几列干脆变成竖排单字。
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      responsive: ['md'],
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      // 「命中」是系统的说法，用户不这么说话。这一列回答的是
      // 「这个词上，有几篇讲的是**我真犯过的错**」——跟点进去摆在外面的那几篇是同一批。
      //
      // 曾经数的是全部命中，于是列上写着「5 篇」、点进去一篇都没摆出来（全收在折叠里，
      // 因为你还没在这个词上错过）。而笔记越攒越多这个差越大：85 篇笔记时
      // comfortable 命中 26 篇，这一列就退化成「这个词有多长」。
      // 「还有多少篇只是沾了音」由词条页那行折叠说，它到了那儿才有用。
      //
      // 也不再用 antd 的 Badge：它取 colorError，而调色板自己写着
      // `red: 只给破坏性操作`（theme.ts）。有几篇讲解是**好事**，却被渲染成整页最饱和
      // 的红点、在表里重复二十多次，读起来像二十多个警报。同一列里「删除」也是红的，
      // 两个红互相抢，而真正该独占红色的是那个删除。
      title: '讲解',
      dataIndex: 'noteCount',
      key: 'noteCount',
      render: (n: number) => (n > 0
        ? <span className="mono" style={{ color: 'var(--blue)' }}>{n} 篇</span>
        : <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      // **标出例外，不标常态**。配了词典 key 之后这一列几乎每行都是「MW 真人」——
      // 一列全同值等于零信息，而原来每行还给它画一个 Tag 方框，四十多个框纯属噪音。
      // 真正值得看一眼的是**没有真人录音**的那几行（合成音练发音会差一截），
      // 所以常态压成弱文字，例外用 amber 标出来。
      // 同上收起来。留下的四列是「点进去要用的」：词条、音标、有没有讲解、删除。
      title: '发音',
      dataIndex: 'audioSource',
      key: 'audioSource',
      responsive: ['md'],
      render: (source: EntryListItem['audioSource']) => (source === 'mw'
        ? <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>真人</Typography.Text>
        : <span style={{ color: 'var(--amber)', fontSize: 12.5 }}>
            {source === 'tts' ? '合成音' : '无音频'}
          </span>),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, record) => (
        // 删词条会连带清掉它的复习进度（server 端 /api/entries/:text DELETE 里
        // deps.review.removeCard），不是无关紧要的小事，所以必须过一道确认。
        <Popconfirm
          title="删除这个词？"
          description="会同时清除它的复习进度，不可恢复"
          okText="删除"
          okType="danger"
          cancelText="取消"
          onConfirm={() => api.deleteEntry(record.text).then(load).catch(() => message.error('没能删除，再试一次；还是不行就看启动窗口里的报错'))}
        >
          {/* 红留给它，但**不是一直亮着**。删词条很少做，却在右边排成一列红字，
              是整页最重的一块颜色。压成弱文字，指过去/键盘落上去才变红——
              该在的时候在，不用的时候不喊。

              这里必须是 <button>：原来是没有 href 的 <a>，浏览器不给它焦点
              （实测 .focus() 之后 activeElement 还是 body，回车也唤不出确认框），
              于是整张表二十行「删除」全都只有鼠标点得动。而它删的是词条连同复习进度。
              CSS 里那条 .danger-link:focus-visible 也就一直是死规则。 */}
          <button type="button" className="danger-link">删除</button>
        </Popconfirm>
      ),
    },
  ];

  // 空库时的起步词。摆在查词框底下——见下面用到它的地方那段注释。
  const starters = (
    <section style={{ borderLeft: '3px solid var(--blue)', paddingLeft: 20 }}>
      <span className="slug" style={{ color: 'var(--blue)' }}>不知道从哪个词开始？</span>
      {/* 中文裹在 {'...'} 里：JSX 会把换行缩进折成一个空格，中文之间多个空格就是个豁口 */}
      <Typography.Paragraph type="secondary" className="measure" style={{ margin: '8px 0 12px', fontSize: 13.5 }}>
        {'这六个词一条对一条盖住中文母语者最容易错的六处，按'}
        <strong>影响听懂的程度</strong>
        {'排。点一下就加好了，直接能开录。'}
      </Typography.Paragraph>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {STARTERS.map(({ word, why }) => (
          <Space key={word} size={10} align="baseline" wrap>
            <Button size="small" loading={adding} onClick={() => void lookUp(word)}>
              {word}
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>{why}</Typography.Text>
          </Space>
        ))}
      </Space>
    </section>
  );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {/* ── 这一页就是查词，复习归侧栏 ──
             这里一度用大字写「有 7 个词要复习」并配一个「开始复习」按钮，于是同一件事
             在一屏里说了三遍：侧栏的「复习 7」、这个标题、这个按钮。而侧栏那个角标
             一直在，翻到哪一页都在——首页再抢一次，只是把查词框往下推。

             当时留它的理由是"窗口一窄侧栏整个缩没"。那条理由是错的：Sider 的
             collapsedWidth={0} 会让 antd 在越过断点时画出重新展开的浮动触发器
             （antd/lib/layout/Sider.js:192 `collapsible || below && zeroWidthTrigger`），
             导航一次都没丢过。 */}
      {entries.length === 0 ? (
        <PageHead slug={APP_NAME} title="先查一个词" />
      ) : (
        <PageHead
          // 眉标跟侧栏同名。这里一度写「单词」，而**单个词的页面眉标也是「单词」**
          // （WordPage 的 `短语 / 单词`），两个不同的页面顶着同一个名字，
          // 于是别处说的「单词页」指哪个就说不清了——而那句话在三个地方出现。
          slug="查词"
          title={`已经查过 ${entries.length} 个词`}
          meta="库里有的直接筛；没有的按「查这个词」现建"
        />
      )}

      {/* ── 查词框紧跟标题 ──
          这一页的活就是查词，那它就该是标题底下第一件够得着的东西。标题那句
          「库里有的直接筛；没有的按「查这个词」现建」说的正是这个框，中间隔着
          别的东西，说明和被说明的对象就对不上了。

          一个框兼两件事：库里有就筛，没有就直接查。原来只能筛——完全不懂的人
          输进一个新词，只会得到"去问 AI"，然后就走不动了。而 /api/entries 本来
          就能建词条（音标、真人录音、音素条、评测全都自动来），只有讲解那一层
          需要 AI。把这条路堵住没有道理。 */}
      {/* ── 这里**不能用 Space** ──
          antd 的 Space 会给每个孩子套一层 `.ant-space-item`，那层是收缩到内容宽的
          flex item。于是给框写的 `maxWidth: 100%` 没有参照物可算——百分比是相对
          那层算的，而那层的宽度又正好等于框自己（340），一圈绕回去，等于没写。
          换成一个普通的块级 flex 容器，百分比才落在**一行的实际宽度**上。 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <Input.Search
          // placeholder 不是名字：一开始打字它就没了，读屏也未必拿它当名字。
          // 这是整个应用的主控件，得说得出自己是什么。
          aria-label="要查的词、短语或音标"
          placeholder="输入一个英文单词、短语，或一个音标（如 θ）…"
          // 默认那个 × 的可访问名是 antd 图标名「close-circle」——一句英文，
          // 念给用中文界面的人听。自带一个说人话的。
          allowClear={{ clearIcon: <span aria-label="清空">✕</span> }}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onSearch={() => void lookUp()}
          enterButton="查这个词"
          loading={adding}
          // 340 是**上限不是宽度**。写死 340 时，360px 的机器（很多安卓机、
          // iPhone SE 都是 375）算下来正文只剩 354－ 而这个框自己就 340，
          // 一挤就把**整页**推成横向滚动（实测 320 和 360 两档都中）。
          // 这一页最要紧的控件不该是把版面撑破的那一个。
          style={{ width: 340, maxWidth: '100%' }}
        />
        {kw.trim() && filtered.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            库里有 {filtered.length} 个匹配，下面列着
          </Typography.Text>
        )}
      </div>

      {/* ── 起步词紧跟查词框，别排在最后 ──
          标题是「先查一个词」，而新用户当场卡住的正是**查哪个**——他不知道自己
          哪些音有问题，那恰恰是他来用这个工具的原因。这一排就是那个答案，
          所以它得挨着问题。原来它排在整页最后：四步说明 + 一整段讲 AI 的话 +
          一条配词典 key 的提示，全都挡在前面，两百多字之后才轮到它。
          实测拉出全新用户的第一屏才看出来——本机有四十多个词条，平时根本走不到这条路。

          输入框里有字的时候不摆：那时候该出场的是下面那个「库里还没有这个词」。 */}
      {entries.length === 0 && !kw.trim() && starters}

      {/* 首页只说侧栏说不了的：卡住的词、反复错却没讲解的音。这两样埋在统计页里，
          不主动端出来就等于没有。到期数不在这儿——侧栏的角标已经够清楚了。 */}
      {entries.length > 0 && <TodayPlan />}

      {attempts !== null && <HowItWorks attempts={attempts} />}

      {mwConfigured === false && !alertDismissed && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => {
            localStorage.setItem(MW_ALERT_DISMISSED, '1');
            setAlertDismissed(true);
          }}
          message="现在放的是合成语音，不是真人发音"
          description={
            <Space direction="vertical" size={4}>
              <span>
                配一个 Merriam-Webster 词典 API key（免费，两三分钟）就能换成美音真人录音——
                {'练发音时差别不小。'}
              </span>
              <Link to="/settings">去设置页配置 →</Link>
            </Space>
          }
        />
      )}

      {kw.trim() && filtered.length === 0 ? (
        /* 不用 antd 的 Empty：它不传 image 就会画自带的那张空盒子插画，
           而这套视觉里没有插画。下面那条「空库时别渲染一张 antd 空表格」是同一个判断，
           当时只处理了表格、漏了这儿。Notice 的 quiet 档是一条中性细线，正合空状态。 */
        <Notice tone="quiet" title={`库里还没有「${kw.trim()}」`}>
          按「查这个词」就能建：音标、真人录音、音素条、评测都会自动配好。
          <br />
          「为什么会错」那种讲解要去问 AI，它写完会自动出现在这个词的页面上。
        </Notice>
      ) : entries.length === 0 ? (
        // 空库时别渲染一张 antd 空表格（"暂无数据" + 一排表头），那是纯死空间。
        // 起步词已经摆在查词框底下了，这儿什么都不要。
        null
      ) : (
        <div>
          <Table<EntryListItem>
            size="small"
            rowKey="text"
            dataSource={filtered}
            columns={columns}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
          />
        </div>
      )}
    </Space>
  );
}
