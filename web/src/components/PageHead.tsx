import type { ReactNode } from 'react';

/**
 * 页头。左侧那枚套准标记不是装饰：它是印刷版上用来对齐两块版的记号，
 * 在这里等于给整站盖上"这一页由黑蓝两版印成"的印记，跟套印带用的是同一套语汇。
 */
export default function PageHead({ slug, title, meta }: {
  /** 小标签：这一页是什么。等宽疏排，跟正文拉开层级 */
  slug: string;
  title: ReactNode;
  /** 一行数据/说明，可选 */
  meta?: ReactNode;
}) {
  return (
    <header className="word-head" style={{ paddingTop: 6 }}>
      <span className="reg-mark" aria-hidden="true"><i /></span>
      <div>
        <span className="slug">{slug}</span>
        <h1
          className="display"
          style={{ marginTop: 8, fontSize: 'clamp(30px, 5vw, 46px)', textWrap: 'balance' }}
        >
          {title}
        </h1>
        {meta && (
          <p className="mono" style={{ margin: '14px 0 0', fontSize: 12.5, color: 'var(--quiet)' }}>
            {meta}
          </p>
        )}
      </div>
    </header>
  );
}
