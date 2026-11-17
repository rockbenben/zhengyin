export type LinkDecision = { kind: 'stay' } | { kind: 'external'; url: string } | { kind: 'deny' };

/**
 * 窗口里的链接去哪。本应用地址留在窗口里；http/https 交给系统浏览器；
 * file: / javascript: 和其它协议一律拒绝——窗口没有地址栏，导航走了就回不来。
 * 相对路径按本应用地址解析，同源就留在窗口里（网页内部跳转要走的就是这条）。
 */
export function decideLink(raw: string, appOrigin: string): LinkDecision {
  let u: URL;
  try { u = new URL(raw, appOrigin); } catch { return { kind: 'deny' }; }
  if (u.origin === appOrigin) return { kind: 'stay' };
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'external', url: u.href };
  return { kind: 'deny' };
}
