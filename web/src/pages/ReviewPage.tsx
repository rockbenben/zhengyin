import { useCallback, useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link } from 'react-router';
import { Button, Space, Spin, message } from 'antd';
import { api, isOffline } from '../api';
import Offline from '../components/Offline';
import { wordIpa } from '../lib/notation';
import PageResult, { LoadFailed } from '../components/PageResult';
import type { EntryDetail, Grade, PronounceResult, ReviewCard } from '../types';
import AudioPlayer from '../components/AudioPlayer';
import AsrStatus from '../components/AsrStatus';
import PhonemeBar from '../components/PhonemeBar';
import NoteHits from '../components/NoteHits';
import { gradeOf } from '../lib/align';
import Recorder from '../components/Recorder';

/**
 * 复习页。
 *
 * **这是一份练习清单，不是一场测验。**
 *
 * 从 Anki 那儿抄来的东西，这一页清过两次。第一次是自评（「忘了 / 模糊 / 记得」）：
 * 自评的前提是你知道自己念得对不对，而这个仓库存在的理由恰恰是你不知道。
 * 现在评分由逐音素评测给。
 *
 * 第二次是**藏答案**。闪卡藏答案，是因为"回忆不出来"这个费劲的过程本身能加固记忆；
 * 而这一页要练的不是记忆，是**舌头的动作**（l/n 不分、ɑ/æ 不分）。藏掉标准音的
 * 后果是顺序反了：凭已有的错动作念一遍 → 被告知错了 → 这才让你听正确的，
 * 等于先把错的练一遍。而且对一个从没听过正确读法的词，"回忆"测的是一个
 * 从来没存进去的东西。
 *
 * 所以标准音、音标、音素条、讲解**一进卡就全摆着**，跟词条页一样。这一页比
 * 词条页多出来的只有一样，也正是别处给不了的：**一份有限、有序、做得完的清单**。
 *
 * 流程：
 *   ① 听标准音，看音标和音素条
 *   ② 念出来录一遍，录完自动评测
 *   ③ 看判定 → 下一个
 *
 * 评分怎么来：
 *   每个音都对         → 记得（下次推远一档；已在最远一档就毕业出列）
 *   有确凿的错         → 忘了（打回最短间隔）
 *   没听出音 / 测不了   → **不打分**，让你重录。测不出来就不该猜一个分数
 *   没录就跳过         → **不打分**。没录音就没有证据，跟上一条同理
 *
 * 一次拿到全部到期卡片，前端本地逐张往前推——评分后不重新拉 /api/review/due。这站得住
 * 是因为 review.ts 的 nextState() 无论哪种 grade，算出来的新 due 最早也是"明天"，
 * 今天之内不会有卡片重新变成到期，本地 slice(1) 跟服务端落盘状态不会走岔。
 */
export default function ReviewPage() {
  useTitle('复习');
  // 「2026-08-07 到期」对人没有意义，「明天」有。隔得远了才报日期。
  function whenLabel(due: string | null): string {
    if (!due) return '';
    const days = Math.round((new Date(`${due}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
    if (days <= 1) return '明天';
    if (days === 2) return '后天';
    return ` ${days} 天后`;
  }

  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [total, setTotal] = useState(0);
  /** 队列里还没到期的：几张、最早哪天。空队列跟「今天轮不到」得说不同的话 */
  const [upcoming, setUpcoming] = useState<{ count: number; next: string | null }>({ count: 0, next: null });
  const [loadError, setLoadError] = useState<null | 'offline' | 'failed'>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [busy, setBusy] = useState(false);
  /** 最近一次评测结果。tried 为真而这里是 null = 测过但测不出来（边车没起、没听出音） */
  const [judged, setJudged] = useState<PronounceResult | null>(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    api.reviewDue()
      // upcoming 是后加的字段：旧响应/旧桩里可能没有，按「没有待办」降级，
      // 别让空队列那一屏整个崩掉（跟统计页的 `stuck = []` 同一条）。
      .then((d) => {
        setQueue(d.cards);
        setTotal(d.cards.length);
        setUpcoming(d.upcoming ?? { count: 0, next: null });
      })
      .catch((e) => setLoadError(isOffline(e) ? 'offline' : 'failed'));
  }, []);

  const card = queue?.[0];

  // 队列必须永远能往前推：卡片对应的词条如果已经被删了，取详情和评分都会一直 404，
  // 重试没有意义——只能丢掉这张、往后走，不能让人卡在一张连内容都取不到的卡上。
  const isNotFound = (e: unknown) => e instanceof Error && e.message === 'API 404';

  const advance = useCallback(() => {
    setQueue((q) => (q ? q.slice(1) : q));
    setDetail(null);
    setJudged(null);
    setTried(false);
  }, []);

  // 一进这张卡就取词条详情：音标、标准音、音素条、讲解全靠它，
  // 而这些现在一进卡就渲染（理由见文件顶上那段）。
  useEffect(() => {
    if (!card) return;
    let alive = true;
    api.getEntry(card.text)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e) => {
        if (!alive) return;
        if (isNotFound(e)) {
          message.warning(`「${card.text}」已被删除，跳过这张卡片`);
          advance();
        } else {
          message.error('没能读出这个词，再试一次；还是不行就看启动窗口里的报错');
        }
      });
    return () => { alive = false; };
  }, [card, advance]);

  const submit = useCallback(async (g: Grade | null) => {
    if (!card || busy) return;
    setBusy(true);
    try {
      // g 为 null = 这次测不出来，不打分直接跳过。测不出来就不该猜一个分数
      if (g) {
        const r = await api.reviewGrade(card.text, g);
        if (r.graduated) message.success(`「${card.text}」你会了，已从复习队列移出`);
      }
      advance();
    } catch (e) {
      if (isNotFound(e)) {
        message.warning('这张复习卡片已不存在，跳过');
        advance();
      } else {
        message.error('没能记下这次结果，再试一次；还是不行就看启动窗口里的报错');
      }
    } finally {
      setBusy(false);
    }
  }, [card, busy, advance]);

  // 打分规则的家在 lib/align.ts 的 gradeOf——纯函数，那边有测试盯着
  const verdict = gradeOf(judged);

  // 键盘：空格 = 下一个（只在录完、且真判出结果之后）。录音不给快捷键——空格误触会开始录音，
  // 那比误触评分更烦。焦点在按钮上时让按钮自己处理，别双触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (t?.tagName === 'BUTTON') return;
      // 只在**真判出结果**时给空格。判不出来那一档（模型没把握 / 没听出音）
      // 界面让人再念一遍，空格却会把这张没判过的卡翻过去——快捷键不能跟
      // 屏幕上写的话对着干。那一档要跳过，得明确去点「跳过这张」。
      if (tried && verdict.grade !== null && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        void submit(verdict.grade);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tried, submit, verdict.grade]);

  // 同上：连不上要的是「怎么把它起起来」，不是「稍后重试」。
  if (loadError === 'offline') return <Offline />;
  if (loadError) {
    return (
      <LoadFailed what="复习队列" />
    );
  }
  // 原来是 return null：加载中整页空白，跟『坏了』分不开
  if (!queue) return <Spin style={{ marginTop: 48 }} />;

  if (queue.length === 0) {
    // 空队列要分三种情况说，**不能只有一套话**。
    //
    // 原来只分「刚复习完」和「其余」，于是队列里明明有卡、只是今天轮不到时，
    // 页面照样说「复习队列只收有证据的词……去首页录一次音」——而刚点完「加入复习」
    // 的人正是从那个按钮走过来的：新卡默认明天到期（review.ts 的 addCard），
    // 他加了四个词，页面却说得像什么都没有。这不是措辞问题，是句假话。
    if (total > 0) {
      return (
        <PageResult slug="复习" title={`复习完了，${total} 张`}>
          今天这一轮做完了。练的是舌头的动作，隔一天再来比今天多做几遍管用。
        </PageResult>
      );
    }
    if (upcoming.count > 0) {
      return (
        <PageResult slug="复习" title="今天没有要复习的">
          {/* 中文裹进 {'...'}：跨行的 JSXText 会把换行折成一个半角空格，
              渲染出来是「到期—— 刚加进来的」，中间多一个豁口 */}
          {'队列里还有 '}<strong>{upcoming.count}</strong>
          {` 个词，最早${whenLabel(upcoming.next)}到期——刚加进来的词都从第二天算起，当天已经练过了。`}
          <br />
          {'等不及就去'}<Link to="/">首页</Link>{'直接查那个词，随时能录。'}
        </PageResult>
      );
    }
    // 真的一张卡都没有：只收有证据的词，这是新用户的常态，得说清什么会让它有东西
    return (
      <PageResult slug="复习" title="今天没有要复习的">
        复习队列只收<strong>有证据</strong>的词：录音真发错了的，或者你在单词页点星加进来的。
        <br />
        去<Link to="/">首页</Link>录一次音，或者在<Link to="/stats">发音统计</Link>看看最近错在哪。
      </PageResult>
    );
  }
  if (!card) return null;

  const done = total - queue.length;
  const hitTags = new Set(detail?.notes.flatMap((n) => n.matched) ?? []);
  const TONE = { ok: 'var(--black)', bad: 'var(--blue)', unknown: 'var(--amber)' } as const;

  return (
    <div style={{ paddingBottom: 8 }}>
      {/* ── 进度 ── */}
      <div style={{ marginBottom: 30 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'baseline' }}>
          <span className="slug">复习 · 第 {done + 1} / {total} 张</span>
          {/* 这两个是并排的同一类小标签，答的是同一个问题：这张卡为什么在这儿。
              所以**两边形状要一样**——都不带主语。「你自己加的」跟「之前念错过」
              摆在一起，一个有「你」一个没有，读着就是歪的。

              用词跟星标按钮对齐：那个按钮写「加入复习」，提示也说「已加入复习」，
              这一页下面还写着「你在单词页点星加进来的」。原来这里写「你收藏的」——
              而 StarButton 的注释里明写着「收藏」这个说法在这个应用里根本不存在，
              它的测试也拦着弹窗里出现它。拦了弹窗，漏了这个标签。 */}
          <span className="slug" style={{ color: card.starred ? 'var(--blue)' : undefined }}>
            {card.starred ? '自己加进来的' : '之前念错过'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              style={{
                height: 3, flex: 1,
                background: i < done ? 'var(--black)' : i === done ? 'var(--blue)' : 'var(--rule)',
              }}
            />
          ))}
        </div>
      </div>

      {/* ── 题面 ── */}
      <header className="word-head" style={{ marginBottom: 22 }}>
        <span className="reg-mark" aria-hidden="true"><i /></span>
        <div>
          <span className="slug">先听标准音，再念给它听</span>
          <h1 className="display" style={{ marginTop: 10 }}>{card.text}</h1>
        </div>
      </header>

      {detail && (
        <Space direction="vertical" size={26} style={{ width: '100%' }}>
          {/* ── 要练的东西：一进卡就摆着（理由见文件顶上那段） ── */}
          {detail.words.map((w, i) => {
            const audio = detail.audio.find((a) => a.word === w.word);
            return (
              <section
                key={w.word}
                style={{
                  borderTop: i > 0 ? '1px solid var(--rule)' : undefined,
                  paddingTop: i > 0 ? 20 : 0,
                }}
              >
                <Space wrap size={16} align="center" style={{ marginBottom: 14 }}>
                  {detail.words.length > 1 && <span style={{ fontWeight: 600, fontSize: 17 }}>{w.word}</span>}
                  <span className="ipa" style={{ fontSize: 24, letterSpacing: '.03em' }}>
                    {wordIpa(w)}
                  </span>
                  <AudioPlayer src={audio?.url ?? null} label={w.word} />
                </Space>
                {w.found && (
                  <PhonemeBar
                    word={w}
                    hitTags={hitTags}
                    onTagClick={(tag) => {
                      const hit = detail.notes.find((n) => n.matched.includes(tag));
                      if (hit) {
                        document.getElementById(`note-${hit.id}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                    }}
                  />
                )}
              </section>
            );
          })}

          {/* ── 录音：必经步骤，一直在，不藏在折叠面板里。
                 **整张卡录一次**，短语也一样——/api/pronounce 支持短语（按词查词典、
                 音素首尾相接后整串对齐）。拆成逐词各录一遍的话，几个分数怎么合成一个
                 说不清；而复习的单位本来就是这张卡。 ── */}
          <div
            id="review-recorder"
            style={{ borderTop: '1px solid var(--rule)', paddingTop: 22 }}
          >
            <Recorder
              target={detail.text}
              entry={detail.text}
              hint="brief"     /* 复习一次要过七八张卡，操作说明只留一句 */
              referenceUrl={detail.phraseAudio?.url ?? detail.audio[0]?.url ?? null}
              onResult={(r) => { setJudged(r); setTried(true); }}
            />
            {/* 服务状态贴着录音区，不劈开「先听再录」的动线 */}
            <AsrStatus />
          </div>

          {detail.notes.length > 0 && <NoteHits notes={detail.notes} emptyHint={false} />}
        </Space>
      )}

      {/* ── 判定 + 下一个：贴在视口底部，翻多少内容都在手边 ── */}
      {tried && (
        <div
          style={{
            position: 'sticky', bottom: 0, marginTop: 32,
            background: 'var(--paper)', borderTop: '2px solid var(--black)', padding: '14px 0 12px',
          }}
        >
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <span style={{ fontSize: 15, color: TONE[verdict.tone] }}>{verdict.text}</span>
            {/* ── 说「再念一遍」就得给「再念一遍」 ──
                模型没把握 / 没听出音时，判定文案写的是「再念一遍」「再录一次」，
                而这里**唯一**的动作曾经是一个写着「下一个」的主按钮，空格也是它。
                嘴上让人重录，手上只给跳过——而且按空格就把一张根本没判过的卡
                悄悄翻过去了（它没打分，所以还会回来，人却不知道发生了什么）。

                所以这一档换一套动作：主按钮回到录音条，跳过降级成次要按钮。
                真判出结果的那两档（对了 / 错了）不动，还是「下一个」+ 空格。 */}
            {verdict.grade === null ? (
              <Space wrap size={10} align="center">
                <Button
                  type="primary"
                  onClick={() => document.getElementById('review-recorder')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                >
                  再念一遍
                </Button>
                <Button loading={busy} onClick={() => void submit(null)}>跳过这张</Button>
                <span className="slug">这次不计入进度</span>
              </Space>
            ) : (
              <Space wrap size={10} align="center">
                <Button type="primary" loading={busy} onClick={() => void submit(verdict.grade)}>
                  下一个
                </Button>
                <span className="slug">或按空格</span>
              </Space>
            )}
          </Space>
        </div>
      )}

      {/* ── 不想练这张就走 ──
             原来这儿是「不会，直接看答案」——那是还在藏答案时的逃生口，而且它按
             "忘了"记分。现在答案本来就摆着，"不会"无从谈起；而跳过是**没录音**，
             没录音就没有证据，不该有分数（跟"测不出来不打分"是同一条）。 */}
      {!tried && (
        <div style={{ marginTop: 26 }}>
          <Space wrap size={10} align="center">
            <Button loading={busy} onClick={() => void submit(null)}>跳过这张</Button>
            <span className="slug">不计入进度</span>
          </Space>
        </div>
      )}
    </div>
  );
}
