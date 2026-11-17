import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

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
    const bindings = c.env?.server ?? c.env;
    if (bindings?.incoming) {
      const peer = getConnInfo(c).remote.address;
      const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
      const path = c.req.path;
      const readable = /^\/api\/(lookup|entries(?:\/.*)?|notes(?:\/.*)?|stats|phonemes(?:\/.*)?|articulation|audio\/.*|review\/due|health)$/.test(path);
      if (!local && path.startsWith('/api/') &&
          (!['GET', 'HEAD'].includes(c.req.method) || !readable)) {
        return c.json({ error: '局域网访问只允许浏览学习内容，请在本机操作' }, 403);
      }
    }
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
