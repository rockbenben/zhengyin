import type { ReactNode } from 'react';

/**
 * 提示块。替掉 antd 的 Alert。
 *
 * 为什么不用 Alert：它的底色是 antd 从 colorInfo / colorWarning 派生出来的。这一版的
 * colorInfo 是深群青，派生出的浅蓝底配上同样是蓝色的链接（colorLink 也来自它），
 * 蓝字压蓝底，对比度直接垮掉——"这几个音还没有笔记"那条就是这么变得看不清的。
 *
 * 这里的做法是：**一律留在纸底上**，只用一条左侧色线和一个小标签区分轻重。
 * 文字永远是正文色压纸，对比度不会因为配色微调而失守；而且彩色方块本来也不属于
 * 这套纸上印墨的语汇。
 */
type Tone = 'note' | 'warn' | 'quiet';

const RULE: Record<Tone, string> = {
  note: 'var(--blue)',
  warn: 'var(--amber)',
  quiet: 'var(--rule)',
};

export default function Notice({ tone = 'note', label, title, children }: {
  tone?: Tone;
  /** 小标签：这是哪一类提示 */
  label?: string;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div style={{ borderLeft: `3px solid ${RULE[tone]}`, paddingLeft: 18 }}>
      {label && <span className="slug" style={{ color: RULE[tone] === 'var(--rule)' ? undefined : RULE[tone] }}>{label}</span>}
      {title && (
        <div style={{ fontWeight: 600, fontSize: 15, lineHeight: 1.5, margin: label ? '5px 0 0' : 0 }}>
          {title}
        </div>
      )}
      {children && (
        <div style={{ fontSize: 14, lineHeight: 1.85, marginTop: title ? 6 : 4, maxWidth: '58ch' }}>
          {children}
        </div>
      )}
    </div>
  );
}
