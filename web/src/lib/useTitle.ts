import { useEffect } from 'react';
import { APP_NAME } from './brand';

/**
 * 这一页在浏览器标签上叫什么。
 *
 * 九个路由原来共用一个 `<title>`：`正音`。页面自己的 h1 各不相同
 * （thin / 你的错误集中在齿龈 / 词典与评测…），可标签页、浏览历史、
 * 收藏夹里全是同一个词——开两个标签分不清哪个是哪个，
 * 收藏一个词条页回头也认不出来。
 *
 * 传 null 表示"还没读出来"（异步页面的第一帧），这时只显示应用名，
 * 不摆一个 `undefined · 正音` 在那儿。
 */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
