import { Link } from 'react-router';
import { whyMatched, SEVERITY_LABEL } from '../lib/notation';
import { Typography } from 'antd';
import type { EntryDetail, Severity } from '../types';

const RULE: Record<Severity, string> = {
  confirmed: 'var(--blue)',
  watch: 'var(--rule)',
  info: 'var(--rule)',
};

/**
 * 只有**录音里反复出现过的**才配一个标签。
 * 其余的不标——它们出现在这里只是因为"这个词里有这个音"，不是对你的判定。
 * （档次怎么定见 server/src/profile.ts 的 severityOf：按你自己的评测记录推。）
 */
/**
 * ── 为什么不再叫「你确认过的短板」 ──
 *
 * 两条都是这个仓库自己写下的规矩，而这个标签同时违反了：
 *
 * 一、**它跟自己的副标题打架。** 副标题写的是「反复出错、而且不止在一个词上出现过，
 *     才会进这里」——那是一句**测量**。标题却说「你确认过」，而使用者从头到尾
 *     什么都没确认过，是工具从录音里推的。同一个措辞问题曾经出现在 frontmatter 的
 *     手写 severity 上：那批判定大多数被使用者本人否认，最后整个字段都改成了派生的。
 *     判据换成了证据，措辞却留着旧的。
 *
 * 二、**「短板」是判决，而证据只支持"反复出现"。** 逐音素判定的可信度分音类：
 *     辅音 41/42，低元音只有 6/10。
 *     所以「这几处你反复对不上」立得住，「这是你的短板」立不住——
 *     ɑ/æ 那篇正文里就明写着"这个标签只有六成把握"，跟标题当场矛盾。
 *
 * 现在只陈述观察到的事：**录音里反复出现**。至于它到底是不是短板，
 * 由他自己看完笔记去判断——那本来就该是他的判断。
 */


interface Props {
  notes: EntryDetail['notes'];
  /**
   * 显示"讲解 · N 篇"那行小标题。放在折叠面板里时关掉——
   * 面板标题已经说了同一件事，再来一遍是重题。
   */
  heading?: boolean;
  /** 一篇都没命中时说什么。折叠面板里根本不会出现空态（没笔记就不渲染那个面板） */
  emptyHint?: boolean;
}

/**
 * 这个词涉及哪些讲解。
 *
 * **只给标题和入口，不摊全文。** 原来每篇都把 markdown 整个铺出来，于是
 * dopamine detox 那一页光笔记正文就 3942 字——而其中 1110 字的 l-vs-n 只是因为
 * 这个词里有个 /n/ 就跟了上来，你还没开口念呢——没必要出现这么一堆。
 *
 * 全文有两个该出现的地方，都比这里合适：
 *   · 笔记自己的页面（/notes/:id）——你主动点进去看的
 *   · 评测报错的旁边——那时候给的是「该怎么动舌头」那几节（guidance），
 *     不是整篇，而且是**你真的错了**才给。「报了错却只丢个链接等于只骂不教」
 *     那条原则由那一路负责，不由这里。
 */
export default function NoteHits({ notes, heading = true, emptyHint = true }: Props) {
  if (notes.length === 0) {
    if (!emptyHint) return null;
    return (
      <Typography.Text type="secondary" style={{ fontSize: 13.5 }}>
        这个词还没有对应的讲解。念着有问题的话，把它发给 AI，它会写成一篇
        <Link to="/notes">发音笔记</Link>。
      </Typography.Text>
    );
  }

  // 跟你有关的（讲这个词的、或你真错过的）排前面，其余收起来。
  // 匹配规则本身是对的——light 有 /l/ 就该能看到 l/n 那篇——但笔记越攒越多，
  // 每个含 /n/ 的词都会挂上 l-vs-n 和 n-vs-ng，列表无限长——
  // 一个词后面拖一长串笔记，完全看不过来。
  // 而音素条上点任意一个音本来就能到那个音的页面，那里列着讲它的笔记——
  // 这一块不必再当一份音素笔记索引。
  // relevant 由服务端算（判据带方向：这篇教得了一处你真犯过的错，而那处错的目标音
  // 就在这个词里）。前端不再拿 severity 凑合——severity 是全局的，
  // 于是每个含 /n/ 的词都会把 l-vs-n 摆在外面，哪怕那个词里没有 /l/。
  const mine = notes.filter((n) => n.relevant);
  // 折叠里按「你在**别的词**上栽过没有」排：severity 是全局判据
  // （跨 ≥2 个词、≥3 次才算 confirmed），所以排在最前的正是
  // 「这个音你在别处反复错，只是还没在这个词上错过」——真要展开翻的人要的就是它。
  // 不动分档：没在这个词上错过的本来就该收起来，这里只管收起来之后谁在上面。
  const RANK: Record<Severity, number> = { confirmed: 0, watch: 1, info: 2 };
  const rest = notes.filter((n) => !mine.includes(n))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  const row = (note: Props['notes'][number]) => (
    <article
      key={note.id}
      id={`note-${note.id}`}
      style={{ scrollMarginTop: 20, borderLeft: `3px solid ${RULE[note.severity]}`, paddingLeft: 18 }}
    >
      {SEVERITY_LABEL[note.severity] && (
        <span className="slug" style={{ color: RULE[note.severity] }}>{SEVERITY_LABEL[note.severity]}</span>
      )}
      <div style={{ margin: SEVERITY_LABEL[note.severity] ? '5px 0 0' : 0 }}>
        <Link to={`/notes/${note.id}`} style={{ fontSize: 15.5, fontWeight: 600 }}>{note.title}</Link>
      </div>
      {/* 这里原来直接印 `命中 phoneme:n`——那是笔记 frontmatter 和分析器之间的约定语法，
          不是给人读的。首页那张表的「命中」列已经因为同样的理由改过一次。 */}
      {/* 摆在外面的说**真实理由**（你在这儿错过什么），折叠里的说怎么匹配上的。
          原来两边都用 whyMatched，于是一篇因为"你把 l 念成了 n"而摆在外面的笔记，
          底下写着「因为这个词里有 l」——说的不是同一件事。 */}
      <span style={{ display: 'block', marginTop: 5, fontSize: 11.5, color: 'var(--quiet)' }}>
        {note.becauseOf.length > 0
          ? `你在这个词上错过 ${note.becauseOf.join('、')}`
          : whyMatched(note.matched)}
      </span>
    </article>
  );

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {heading && mine.length > 0 && <span className="slug">这个词的讲解 · {mine.length} 篇</span>}
      {mine.map(row)}
      {rest.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--quiet)' }}>
            另有 {rest.length} 篇讲到这个词里的音，但你还没在这个词上错过
          </summary>
          <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>{rest.map(row)}</div>
        </details>
      )}
    </div>
  );
}
