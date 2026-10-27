import type { MiddlewareHandler } from 'hono';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_CT = ['application/json', 'application/octet-stream'];

/** Origin 缺席（curl / 同源 fetch 之外的工具）、环回、或与请求 Host 同源 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (LOOPBACK.has(o.hostname)) return true;
    return Boolean(host) && o.host === host;
  } catch {
    return false;
  }
}

/** 有体的写请求只收 JSON 和二进制音频；text/plain 的简单请求没有预检 */
export function contentTypeAllowed(ct: string | undefined): boolean {
  if (!ct) return true;
  const base = ct.split(';')[0]!.trim().toLowerCase();
  return ALLOWED_CT.includes(base);
}

export function writeGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (WRITE.has(c.req.method)) {
      if (!originAllowed(c.req.header('origin'), c.req.header('host'))) {
        return c.json({ error: '跨站请求被拒绝' }, 403);
      }
      if (!contentTypeAllowed(c.req.header('content-type'))) {
        return c.json({ error: '写请求只接受 JSON 或二进制音频' }, 403);
      }
    }
    await next();
  };
}
