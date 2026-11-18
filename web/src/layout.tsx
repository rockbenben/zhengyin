import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Link, Outlet, useLocation } from 'react-router';
import { api } from './api';
import { UserSwitcher } from './components/UserSwitcher';
import { applyPalette, makeTheme, paletteFor } from './theme';
import { isDarkPaper, loadHue, loadPaper, savePaper, saveHue, type PaperPref } from './lib/ink';
import {
  BarChartOutlined, BookOutlined, CalendarOutlined, CommentOutlined,
  GithubOutlined, MenuOutlined, ReadOutlined, SearchOutlined, SettingOutlined, SnippetsOutlined,
} from '@ant-design/icons';
import { APP_NAME, APP_TAGLINE, REPO_URL } from './lib/brand';
import { STATS_CHANGED } from './lib/events';

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
 * 宽屏侧栏与窄屏顶栏共用同一套导航。
 *
 * 主题可选跟随系统 / 浅色 / 深色；跟随系统时实时响应切换（不是只在启动时读一次）。
 * 两套底色调色板在 theme.ts，第二版油墨由 ink.ts 按色相算；applyPalette 把结果写进
 * CSS variables，antd 的 token 从同一个对象生成——两边同源，改配色只改一处，不会漂移。
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
  const [showMore, setShowMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);

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

  const refreshCounts = useCallback(() => {
    api.reviewDue().then((d) => setDueCount(d.cards.length)).catch(() => {});
    api.stats().then((s) => setAttempts(s.overall.attempts)).catch(() => {});
  }, []);

  // 换页时拉一次；录音 / 评分 / 删词后在页面里发 STATS_CHANGED，不换页也重拉。
  useEffect(() => { refreshCounts(); }, [loc, refreshCounts]);
  useEffect(() => { setShowMore(false); }, [loc.key]);
  useEffect(() => {
    window.addEventListener(STATS_CHANGED, refreshCounts);
    return () => window.removeEventListener(STATS_CHANGED, refreshCounts);
  }, [refreshCounts]);

  const selected = [
    '/phonemes', '/notes', '/review', '/stats', '/assistant', '/organize', '/settings',
  ].find((path) => loc.pathname.startsWith(path === '/phonemes' ? '/phoneme' : path)) ?? '/';

  const navLink = (to: string, icon: ReactNode, label: ReactNode) => (
    <Link to={to} aria-current={selected === to ? 'page' : undefined} onClick={() => setShowMore(false)}>
      {icon}
      {label}
    </Link>
  );

  return (
    <ConfigProvider locale={zhCN} theme={makeTheme(palette)}>
      <div className="app-shell">
        <a className="skip-link" href="#main">跳到正文</a>
        <header className="app-rail">
          <div className="nav-brand">
            <span className="reg-mark" aria-hidden="true"><i /></span>
            <span>
              <b>{APP_NAME}</b>
              <small>{APP_TAGLINE}</small>
            </span>
          </div>
          <nav className="app-nav" aria-label="主导航" onKeyDown={(event) => {
            if (event.key !== 'Escape' || !showMore) return;
            setShowMore(false);
            moreButton.current?.focus();
          }}>
            <div className="nav-primary">
              {navLink('/', <SearchOutlined aria-hidden="true" />, '查词')}
              {navLink('/review', <CalendarOutlined aria-hidden="true" />, (
                <>复习{dueCount > 0 && <span className="due-count">{dueCount}</span>}</>
              ))}
            </div>
            <button
              type="button"
              className="nav-more"
              ref={moreButton}
              aria-expanded={showMore}
              aria-controls="nav-more-panel"
              onClick={() => setShowMore(!showMore)}
            >
              <MenuOutlined aria-hidden="true" />
              更多
            </button>
            <div className="nav-more-panel" id="nav-more-panel" data-open={showMore}>
              <div className="nav-group">
                <div className="nav-label">发音资料</div>
                {navLink('/phonemes', <BookOutlined aria-hidden="true" />, '音素')}
                {navLink('/notes', <ReadOutlined aria-hidden="true" />, '发音笔记')}
                {navLink('/stats', <BarChartOutlined aria-hidden="true" />, '发音统计')}
              </div>
              <div className="nav-group">
                <div className="nav-label">AI</div>
                {navLink('/assistant', <CommentOutlined aria-hidden="true" />, 'AI 助教')}
                {navLink('/organize', <SnippetsOutlined aria-hidden="true" />, 'AI 整理')}
              </div>
              <div className="nav-group">
                {navLink('/settings', <SettingOutlined aria-hidden="true" />, '设置')}
              </div>
              <div className="nav-foot">
                <UserSwitcher />
                {attempts !== null && <span>已评测 <b>{attempts}</b> 次</span>}
                <a className="nav-repo" href={REPO_URL} target="_blank" rel="noreferrer">
                  <GithubOutlined aria-hidden="true" />
                  源码
                </a>
              </div>
            </div>
          </nav>
        </header>

        <main className="page" id="main" tabIndex={-1}>
          <div className="page-inner">
            <Outlet context={{ hue, setHue: changeInk, dark, paper, setPaper: changePaper } satisfies InkContext} />
          </div>
        </main>
      </div>
    </ConfigProvider>
  );
}
