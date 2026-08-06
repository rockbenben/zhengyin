import { useEffect, useState, type ReactNode } from 'react';
import { Layout, Menu, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Link, Outlet, useLocation } from 'react-router';
import { api } from './api';
import { UserSwitcher } from './components/UserSwitcher';
import { applyPalette, makeTheme, paletteFor } from './theme';
import { isDarkPaper, loadHue, loadPaper, savePaper, saveHue, type PaperPref } from './lib/ink';
import { GithubOutlined } from '@ant-design/icons';
import { APP_NAME, APP_TAGLINE, REPO_URL } from './lib/brand';

/** 设置页靠它换墨。用 Outlet context 而不是另起一个全局 store——只有一个消费者 */
export interface InkContext {
  hue: number;
  setHue: (hue: number) => void;
  /** 现在是深色纸吗（偏好和系统状态合起来的结果）。色块要按当前这套纸画 */
  dark: boolean;
  /** 用哪套纸：跟随系统 / 浅色 / 深色 */
  paper: PaperPref;
  setPaper: (p: PaperPref) => void;
}

/**
 * 外壳。侧栏是印刷车间的版口：套准标记、刊头、页脚的印次记录。
 *
 * 主题跟随系统深色/浅色，实时响应切换（不是只在启动时读一次）。两套调色板都在
 * theme.ts 里，applyPalette 把它写进 CSS variables，antd 的 token 从同一个对象生成——
 * 两边同源，改配色只改一处，不会漂移。
 */
export default function AppLayout() {
  // 系统当前是什么，跟**用哪套纸**是两件事：前者是外界事实，后者是他的选择。
  // 合成一个 dark 布尔存下来的话，"跟随系统"就没地方表达了。
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [paper, setPaper] = useState<PaperPref>(loadPaper);
  // 第二版油墨的色相。深浅跟系统走，墨色跟人走——两件事互不干涉
  const [hue, setHue] = useState(loadHue);
  const [dueCount, setDueCount] = useState(0);
  const [attempts, setAttempts] = useState<number | null>(null);
  const loc = useLocation();

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const dark = isDarkPaper(paper, systemDark);
  const palette = paletteFor(dark, hue);
  const changeInk = (h: number) => { setHue(h); saveHue(h); };
  const changePaper = (p: PaperPref) => { setPaper(p); savePaper(p); };
  useEffect(() => {
    applyPalette(palette);
    // styles.css 里有几处要按主题改混色模式（深底上 multiply 会把蓝版吃掉），
    // 靠这个属性切换，跟 prefers-color-scheme 的媒体查询双保险。
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [palette, dark]);

  useEffect(() => {
    api.reviewDue().then((d) => setDueCount(d.cards.length)).catch(() => {});
    api.stats().then((s) => setAttempts(s.overall.attempts)).catch(() => {});
  }, [loc]);

  /**
   * 导航分两组，因为这六项本来就不是同级的东西。
   *
   * 六个平铺的同级项会让人以为它们地位相当，而实际上只有前两项是**要每天做的**，
   * 后三项是查阅用的。分组之后"这工具怎么用"从导航上就看得出来，不用先读一段说明。
   *
   * 第一项原来叫「查询历史」——那是个**日志的名字**，而那一页恰恰是整个流程的入口
   * （输入框按「查这个词」就建词条）。而且页面自己的标题写的是「先查一个词」/
   * 「已经查过 N 个词」，导航和页面对同一件事两个叫法。改成「查词」，跟动作对齐。
   */
  // 路径前缀 → 该高亮哪一项。**音素那条的前缀是单数**：菜单键是 /phonemes，
  // 而详情页是 /phoneme/<ipa>，用 '/phonemes' 当前缀的话详情页一个都匹配不上，
  // 会掉回默认的首页高亮。单数形同时覆盖列表页和详情页。
  const NAV: Array<{ prefix: string; key: string }> = [
    { prefix: '/phoneme', key: '/phonemes' },
    { prefix: '/notes', key: '/notes' },
    { prefix: '/review', key: '/review' },
    { prefix: '/stats', key: '/stats' },
    { prefix: '/settings', key: '/settings' },
  ];
  const selected = NAV.find((n) => loc.pathname.startsWith(n.prefix))?.key ?? '/';

  /**
   * 导航链接。**当前项要带 aria-current**：antd 只给 `.ant-menu-item-selected`
   * 这个类，那是画给眼睛看的；读屏拿不到任何"你在这一页"的状态。
   */
  const navLink = (to: string, label: ReactNode) => (
    <Link to={to} aria-current={selected === to ? 'page' : undefined}>{label}</Link>
  );

  const items = [
    {
      type: 'group' as const,
      label: <span className="slug">每天做的</span>,
      children: [
        { key: '/', label: navLink('/', '查词') },
        {
          key: '/review',
          // 到期数用**蓝版**，不用 antd 的 Badge。
          // Badge 取的是 colorError，而这套调色板自己写着 `red: 只给破坏性操作`
          // （theme.ts 那一行）——今天有几个词要练，不是破坏性操作，也不是错误。
          // 蓝是这个应用的动作色（「去复习」那个链接就是蓝的），数字跟动作同色才对得上。
          label: navLink('/review', <>复习{dueCount > 0 && <span className="due-count">{dueCount}</span>}</>),
        },
      ],
    },
    {
      type: 'group' as const,
      label: <span className="slug">查阅</span>,
      children: [
        // 「音素」和「发音笔记」是并列的两件事，挨着摆：
        // 音素 = 这个音客观怎么发（41 个全有，跟谁在念无关）
        // 发音笔记 = 你自己在某个音 / 某个词上的问题（只在念差了之后才写）
        { key: '/phonemes', label: navLink('/phonemes', '音素') },
        { key: '/notes', label: navLink('/notes', '发音笔记') },
        { key: '/stats', label: navLink('/stats', '发音统计') },
      ],
    },
    { type: 'divider' as const },
    { key: '/settings', label: navLink('/settings', '设置') },
  ];

  return (
    <ConfigProvider locale={zhCN} theme={makeTheme(palette)}>
      <Layout style={{ minHeight: '100vh' }}>
        {/* 键盘用户每翻一页都要先穿过侧栏那一串导航（六个链接）才够得着正文。
            这条链接平时不占位，Tab 一下才现身——它是全页第一个可聚焦的东西。 */}
        <a className="skip-link" href="#main">跳到正文</a>
        {/* 窄到 lg 以下侧栏收成零宽，antd 会甩出一个重开按钮。它默认摆在 top:68px、
            绝对定位在内容之上——实测八个页面的标题或副标题全被盖掉一角。
            所以位置自己给（挪进 .page 让出来的那条横带），按钮也自己给：
            antd 那个是 tabIndex -1 的 <span>，键盘按不到，窄屏下整个导航够不着。 */}
        <Layout.Sider
          width={196}
          breakpoint="lg"
          collapsedWidth={0}
          zeroWidthTriggerStyle={{ top: 14, insetInlineEnd: -62, width: 44, height: 44 }}
          trigger={<button type="button" className="nav-open" aria-label="打开导航">☰</button>}
          style={{ borderInlineEnd: '1px solid var(--rule)' }}
        >
          <div className="nav-brand">
            <span className="reg-mark" aria-hidden="true"><i /></span>
            <span>
              <b>{APP_NAME}</b>
              <small>{APP_TAGLINE}</small>
            </span>
          </div>
          <Menu mode="inline" items={items} selectedKeys={[selected]} style={{ borderInlineEnd: 0, paddingTop: 8 }} />
          <div style={{ flex: 1 }} />
          {/* 版口：印刷版边上那条记录印次和出处的窄带。
              这里只放**这台机器上的事实**——练了多少次、源码在哪。

              原来第二行是「笔记是唯一的知识来源」。那句是 README 里
              「笔记驱动一切」那条**架构主张**，是代码在跟自己说话：
              站在侧栏的人既做不了什么，也判断不了它是真是假。
              整块页脚不再挂在 attempts 上：取统计失败时，
              连「源码在哪」也跟着消失没有道理。 */}
          <div className="nav-foot">
            {/* 谁在机上、印了几次、哪儿出的——版口记的就是这三样 */}
            <UserSwitcher />
            {attempts !== null && <span>已评测 <b>{attempts}</b> 次</span>}
            <a
              className="nav-repo"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              <GithubOutlined aria-hidden="true" />
              源码
            </a>
          </div>
        </Layout.Sider>

        {/* 内边距挪去 CSS：窄屏那一档要给上面那个按钮让出一条横带，
            而行内 style 压不过媒体查询，只能靠 !important 硬顶。 */}
        <Layout.Content className="page" id="main" tabIndex={-1}>
          <div style={{ maxWidth: 940, margin: '0 auto' }}>
            <Outlet context={{ hue, setHue: changeInk, dark, paper, setPaper: changePaper } satisfies InkContext} />
          </div>
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
