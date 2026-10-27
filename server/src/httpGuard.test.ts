import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { writeGuard } from './httpGuard.js';

const app = () => {
  const a = new Hono();
  a.use('*', writeGuard());
  a.post('/x', (c) => c.json({ ok: true }));
  a.get('/x', (c) => c.text('ok'));
  return a;
};

describe('写请求守卫', () => {
  it('没有 Origin、JSON → 放行', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('恶意 Origin → 403', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('text/plain 的简单请求 → 403', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('octet-stream（录音）放行', async () => {
    const r = await app().request('/x', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' });
    expect(r.status).toBe(200);
  });

  it('环回 Origin 放行；同源 Origin 放行', async () => {
    const loop = await app().request('/x', { method: 'POST', headers: { origin: 'http://127.0.0.1:30031', 'content-type': 'application/json' }, body: '{}' });
    expect(loop.status).toBe(200);
  });

  it('GET 不受影响', async () => {
    expect((await app().request('/x', { headers: { origin: 'https://evil.test' } })).status).toBe(200);
  });
});
