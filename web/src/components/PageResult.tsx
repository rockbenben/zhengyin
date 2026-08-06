import type { ReactNode } from 'react';
import { Button } from 'antd';
import PageHead from './PageHead';

/**
 * 整页的结果状态：找不到、读不出来、这一档空着、这一轮做完了。
 *
 * ── 为什么不用 antd 的 Result ──
 *
 * 跟 Notice 换掉 Alert 是同一条理由：**彩色方块不属于这套纸上印墨的语汇**。
 * Result 更过分——`status="404"` 会摆一张 antd 自带的卡通插画（蓝白小人抱纸箱、
 * 亮蓝圆圈、绿色植物），而**绿色这个色相调色板里根本没有**（墨屉全是冷色）。
 * `status="error"` 则是个大红叉，而调色板写着**红只给破坏性操作**——
 * 读不出列表不是破坏性操作。
 *
 * 同一条理由对 antd 的 `Empty` 一样成立（不传 `image` 就画自带的那张空盒子），
 * 首页搜不到词、统计页没有记录时原本都在用它，现已换成 `Notice tone="quiet"`——
 * 一条中性细线，空状态既不是提示也不是警告。**现在全站没有任何 antd 自带插画**。
 *
 * 还有一件只在读屏时才发现的：Result 把标题渲染成 `<div>`，于是这些页面
 * 整页没有一个 `<h1>`（实测九个内容页都恰好一个，只有这些状态页是零）。
 *
 * 三件事一个来源：这些状态本来就该用**页头**说话，跟别的页面一样。
 * PageHead 给的就是套准标记 + slug + h1.display。
 */
export default function PageResult({ slug, title, children, extra }: {
  /** 小标签：这是哪一类状态（找不到 / 读不出来 / …） */
  slug: string;
  title: ReactNode;
  /** 解释 + 下一步。错误提示说了原因就得给下一步 */
  children?: ReactNode;
  /** 主动作，可选 */
  extra?: ReactNode;
}) {
  return (
    <div>
      <PageHead slug={slug} title={title} />
      {/* 这个 class 是给测试用的钩子：断言"说明文字讲清了下一步"必须**避开按钮**，
          拿整页 textContent 断言会被按钮上的字骗过（变异测试里真活下来过一次）。 */}
      {children && (
        <p className="result-body measure" style={{ margin: '18px 0 0', fontSize: 14.5, lineHeight: 1.9 }}>
          {children}
        </p>
      )}
      {extra && <div style={{ marginTop: 22 }}>{extra}</div>}
    </div>
  );
}

/**
 * 「服务在跑，但这次没读出来」。原来在五个页面里各写了一遍——标题、副标题、
 * 刷新按钮一字不差，只有读的是什么不同。
 */
export function LoadFailed({ what }: { what: string }) {
  return (
    <PageResult
      slug="读不出来"
      title={`没能读出${what}`}
      extra={<Button type="primary" onClick={() => window.location.reload()}>刷新</Button>}
    >
      服务在跑，但这次请求出错了。刷新一下；还是不行的话看启动那个窗口里的报错。
    </PageResult>
  );
}
