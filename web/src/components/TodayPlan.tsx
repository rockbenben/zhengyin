import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Typography } from 'antd';
import { api } from '../api';
import { describeError, errorPhoneme } from '../lib/notation';
import type { StatsResult } from '../types';

/**
 * 卡住的地方。
 *
 * ── 为什么需要它 ──
 *
 * 「该练什么」的答案原来散在三处：复习页只给到期的卡，统计页给卡住的词和反复出错
 * 的音，而**该补哪篇讲解**只写在 `发音档案.md` 那个文件里。一个只用网页的人
 * 要自己在两三页之间拼出结论，多数人不会拼——于是每次打开都从"再查一个词"开始，
 * 而真正该练的那几个词躺在别处。
 *
 * ── 为什么**不**管到期复习 ──
 *
 * 这里一度还列一行「复习 N 个词」。可到期数侧栏一直挂着（翻到哪一页都在），
 * 首页再说一遍只是重复。**这一块的分工是：只端出侧栏端不出来的东西。**
 * 卡住的词和没讲解的音都埋在统计页里，不主动摊开就等于没有——那才是它的活。
 *
 * 判据一个都不在这儿重算：卡住的词和「够格补一篇」都直接读 /api/stats 的
 * stuck / worthANote（服务端的 stuckWords 和 worthANote）。
 * 门槛留在前端会长出拷贝——sure 的 0.5 就是这么长出三份的。
 */
export default function TodayPlan() {
  const [stats, setStats] = useState<StatsResult | null>(null);

  useEffect(() => {
    let alive = true;
    api.stats().then((s) => { if (alive) setStats(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const allStuck = stats?.stuck ?? [];
  const stuck = allStuck.slice(0, 3);
  // 反复出错、够格写一篇、而且**还没有**讲解的音。有讲解的不算——那不是待办，
  // 那是"去看那篇讲解"，词条页在你再错时本来就会摊开它。
  const needNote = (stats?.phonemes ?? []).filter((p) => p.worthANote && p.notes.length === 0);

  // ── 整块最多三行 ──
  //
  // 音素那部分一度是"每个音一行、最多三行"，加上卡住的词那一行就是四行；
  // 练得越久这块越长，而**满屏都是「你卡住了」等于什么都没说**——
  // 它是一句"接下来干这个"的提示，不是一份报告。报告在发音统计页。
  //
  // 卡住的词占一行（词并排放在同一行里），剩下的行数给音素。
  const MAX_ROWS = 3;
  const noteShown = needNote.slice(0, MAX_ROWS - (stuck.length > 0 ? 1 : 0));
  // **截断了就要说出来。** 悄悄砍掉读起来就像"就这些了"，而这个仓库对
  // 静默截断的态度是明确的：宁可多一行字，也不要让人以为已经全看过了。
  // 顺带把 stuck 自己截掉的那几个也算进来——它本来就一直在悄悄砍。
  const hidden = (allStuck.length - stuck.length) + (needNote.length - noteShown.length);

  if (stuck.length === 0 && needNote.length === 0) return null;

  const row = (key: string, action: React.ReactNode, why: string) => (
    <div
      key={key}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
        padding: '9px 0', borderTop: '1px solid var(--rule)',
      }}
    >
      <span style={{ fontSize: 15 }}>{action}</span>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>{why}</Typography.Text>
    </div>
  );

  return (
    <section>
      <span className="slug">卡住的地方</span>
      <div style={{ marginTop: 8 }}>
        {stuck.length > 0 && row(
          'stuck',
          <>
            {stuck.map((w, i) => (
              <span key={w.text}>
                {i > 0 && <span style={{ margin: '0 7px', color: 'var(--rule)' }}>·</span>}
                <Link to={`/word/${encodeURIComponent(w.text)}`}>{w.text}</Link>
              </span>
            ))}
          </>,
          '练了很多次还是过不去，值得单独盯',
        )}

        {/* ── 说出是哪个音，链到那个音自己的页 ──
            顺序由服务端给（按次数从多到少），所以截断留下的就是最要紧的那几个。

            右边那格**只放例词，不放指令**。原来跟着一句「点进去看这个音怎么发」，
            而它每行一模一样——标签本身就是链接，那句话在替控件说它已经说了的事。
            几行叠起来读着像复制粘贴，而这一块最多才三行。 */}
        {noteShown.map((p) => {
          const ipa = errorPhoneme(p);
          const label = describeError(p);
          return row(
            `note-${p.kind}-${p.targetIpa ?? ''}-${p.heardIpa ?? ''}`,
            ipa
              ? <Link to={`/phoneme/${encodeURIComponent(ipa)}`}>{label} · {p.count} 次</Link>
              : <>{label} · {p.count} 次</>,
            `在 ${p.words.slice(0, 2).join('、')} 上`,
          );
        })}

        {/* 砍掉的那些不能不吭声——不说的话这三行读起来就是"就这些了"。
            不做成一行 row：它不是一件要做的事，是一句交代。 */}
        {hidden > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12.5, display: 'block', paddingTop: 9 }}>
            另外还有 {hidden} 处没列在这儿，<Link to="/stats">发音统计</Link>里全都在。
          </Typography.Text>
        )}
      </div>
    </section>
  );
}
