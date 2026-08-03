import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 笔记正文。
 *
 * **必须挂 remark-gfm**：表格是 GFM 扩展，CommonMark 里没有。裸用 react-markdown 的话
 * 一张表会原样糊成一行管道符——
 * `| 词 | 音标 | |---|---| | box | /bɑks/ |`。而**十七篇笔记全都用表格**（这个数
 * 写下时是"六篇里有五篇"，笔记攒到十七篇之后成了全部），
 * 砸的正好是信息密度最高的那几段：minimal pairs 对照、错法对照、词尾连缀一览。
 * 这是模拟新用户走一遍时撞出来的：点进 desk 第一屏就是那团管道符。
 *
 * **去掉开头那个 H1**：调用方（命中笔记、笔记详情页）都已经把 frontmatter 的 title
 * 排在自己的页头上了——不去掉的话同一件事连着出现两遍，而且里面那个 H1 比外面的标题
 * 还大，层级整个是倒的。这就是"格式有点乱"的主因。
 *
 * 注意**不能假定这两句话完全一样**。十七篇里有五篇不一样（dopamine-detox、ine、
 * kl-click、ks、ɑ-æ），措辞各写各的。逐篇看过：那五篇的 title 都写得比 H1 更准
 * （H1 是"这篇讲什么"，title 是"你会错在哪"），H1 里那点独有的信息也都在正文里出现过
 * （如 ɑ-æ 的"中文里一个都没有"在正文 99 行），所以照删不丢东西。
 * 真要改这条规则，得先逐篇核对一遍——**它删的是内容，不是重复**。
 *
 * 只砍**开头连续空白之后的第一个** H1；正文中间万一还有 H1 不动它——那是内容，不是重题。
 */
export default function NoteBody({ markdown }: { markdown: string }) {
  return (
    <div className="note-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 对照表列多的时候，横向滚动要发生在**表自己身上**——
          // 不包一层的话窄窗口下整个页面跟着横滚，那是页面级的坏。
          table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
        }}
      >
        {stripLeadingTitle(markdown)}
      </ReactMarkdown>
    </div>
  );
}

export function stripLeadingTitle(markdown: string): string {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !/^#\s+\S/.test(lines[i])) return markdown;

  lines.splice(0, i + 1);
  // 顺带吃掉标题后面紧跟的空行，免得正文顶上多一段空白
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
}
