import type * as T from './types';

/**
 * 「连不上服务」跟「服务说没有」是两回事，**界面必须分得开**。
 *
 * fetch 在服务停掉时抛的是 TypeError，跟 404 抛的 Error 长得不一样，但调用方一律
 * `.catch(() => setError(true))`，于是两件事合成一件。实测后果：把服务关掉之后，
 * **每一个词条页都说「库里还没有这个词」**，还请你回首页去建——而首页同样连不上。
 * 一个本地工具最常见的故障（窗口被关掉了），界面给的是一条走不通的路。
 *
 * 所以网络失败单独标出来。用一个字段而不是自定义 Error 子类：跨 bundle 的
 * instanceof 不可靠，而这个判断只在本仓库内部用。
 */
export interface OfflineError extends Error { offline: true }

export function isOffline(e: unknown): e is OfflineError {
  return typeof e === 'object' && e !== null && (e as { offline?: unknown }).offline === true;
}

function offline(cause: unknown): OfflineError {
  const e = new Error('连不上正音的服务') as OfflineError;
  e.offline = true;
  e.cause = cause;
  return e;
}

async function j<R>(res: Promise<Response>): Promise<R> {
  let r: Response;
  try {
    r = await res;
  } catch (e) {
    throw offline(e);          // 服务没起 / 被关掉 / 端口变了
  }
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

// 跟 j() 的区别：把服务端 JSON 里的 error 文案带出来。设置页要靠它区分"key 无效"和
// "连不上词典服务"——只抛 `API 400` 的话用户无从判断该换 key 还是等网络。
// 其余接口继续用 j()：那些地方的失败对用户是一句话带过的，ReviewPage 还依赖 `API 404`
// 这个精确文案判断"卡片已被删"，不能改。
async function jx<R>(res: Promise<Response>): Promise<R> {
  let r: Response;
  try {
    r = await res;
  } catch (e) {
    throw offline(e);
  }
  const body: unknown = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `API ${r.status}`;
    throw new Error(msg);
  }
  return body as R;
}

export const api = {
  health: () => j<{ ok: boolean; mwConfigured: boolean }>(fetch('/api/health')),

  addEntry: (text: string) => jx<T.EntryDetail>(fetch('/api/entries', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })),

  listEntries: () => j<{ entries: T.EntryListItem[] }>(fetch('/api/entries')),
  // 404 单独剥出来：空状态要按「在不在词典」分叉承诺（服务端在 404 体里给
  // inDictionary）。走 j() 的话状态码和 body 一起淹死在 `API 404` 里。
  // message 保持 `API 404` 不变——ReviewPage 靠它认出"卡片对应的词条已被删"。
  getEntry: async (text: string): Promise<T.EntryDetail> => {
    let r: Response;
    try {
      r = await fetch(`/api/entries/${encodeURIComponent(text)}`);
    } catch (e) {
      throw offline(e);
    }
    if (r.status === 404) {
      const body = await r.json().catch(() => ({})) as { inDictionary?: boolean };
      const err = new Error('API 404') as Error & { notFound?: { inDictionary?: boolean } };
      err.notFound = { inDictionary: body.inDictionary };
      throw err;
    }
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
  },
  deleteEntry: (text: string) => j<{ ok: boolean }>(fetch(`/api/entries/${encodeURIComponent(text)}`, {
    method: 'DELETE',
  })),

  listNotes: () => j<{ groups: T.NoteGroups }>(fetch('/api/notes')),
  getNote: (id: string) => j<T.NoteDetail>(fetch(`/api/notes/${encodeURIComponent(id)}`)),

  // upcoming = 队列里还没到期的：几张、最早哪天。空队列和「今天轮不到」要说不同的话
  reviewDue: () => j<{ cards: T.ReviewCard[]; upcoming: { count: number; next: string | null } }>(
    fetch('/api/review/due'),
  ),
  star: (text: string, on: boolean) => jx<{ starred: boolean }>(
    fetch(`/api/review/${encodeURIComponent(text)}/star`, { method: on ? 'PUT' : 'DELETE' }),
  ),
  reviewGrade: (text: string, grade: T.Grade) => j<T.GradeResult>(fetch(`/api/review/${encodeURIComponent(text)}`, {
    method: 'POST',
    body: JSON.stringify({ grade }),
    headers: { 'content-type': 'application/json' },
  })),

  // 服务端已不再接收音频：语音识别在浏览器本地完成（Task 17），这里只把识别到的文本 heard
  // 和目标文本 target 一起交给服务端做音素 diff + 笔记命中。
  asr: (target: string, heard: string) => j<T.AsrResult>(fetch('/api/asr', {
    method: 'POST',
    body: JSON.stringify({ target, heard }),
    headers: { 'content-type': 'application/json' },
  })),

  // 给 ASR 识别语法用的"容易混淆的真实词"，音素层面的推导（笔记 phoneme:<ipa>
  // trigger 共现 + CMUdict 反查）只在服务端做——客户端没有词典，也不该有一份自己
  // 的音系规则副本（Task 15 定下的原则，web/src/lib/asr.ts 不再自己猜拼写）。
  getMwKey: () => j<T.MwKeyState>(fetch('/api/settings/mw-key')),
  setMwKey: (key: string, verify = true) => jx<T.MwKeyState>(fetch('/api/settings/mw-key', {
    method: 'PUT',
    body: JSON.stringify({ key, verify }),
    headers: { 'content-type': 'application/json' },
  })),
  clearMwKey: () => jx<T.MwKeyState>(fetch('/api/settings/mw-key', { method: 'DELETE' })),

  getModel: () => j<T.ModelState>(fetch('/api/settings/model')),
  setModel: (id: string) => jx<T.ModelState>(fetch('/api/settings/model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })),

  // 录音只在本机两个进程之间走（浏览器 → 30031 → 127.0.0.1:30032 的边车），不落盘、
  // 不出这台机器。服务端 503 表示边车没起，调用方据此降级回 vosk 二选一。
  articulation: () => j<T.ArticulationTable>(fetch('/api/articulation')),

  stats: () => j<T.StatsResult>(fetch('/api/stats')),

  pronounceHealth: () => j<T.PronounceHealth>(fetch('/api/pronounce/health')),

  // 音素文档。IPA 符号要编码进路径（ə、ʃ 这些不是 URL 安全字符）
  phonemes: () => j<T.PhonemeList>(fetch('/api/phonemes')),
  phoneme: (ipa: string) => j<T.PhonemeDetail>(fetch(`/api/phonemes/${encodeURIComponent(ipa)}`)),

  // 不走 jx：调用方必须能区分"边车没起"（503 → 降级回 vosk）和"这个词查不到"
  // （400 → 直接告诉用户），而 jx 把状态码丢了只留一条错误消息。
  /**
   * @param entry 这次录音所属的词条。短语页是逐词录的（"dark night" 里单独录 dark），
   *   而 dark 本身不是词条——不传的话流水和复习卡会记在裸词上，统计里的例词链接打不开、
   *   复习队列里还会多出一张永远打不开的卡。
   */
  pronounce: async (target: string, wav: Blob, entry?: string, snrDb?: number): Promise<
    { ok: true; data: T.PronounceResult } | { ok: false; sidecarDown: boolean; error: string }
  > => {
    const q = new URLSearchParams({ target });
    if (entry) q.set('entry', entry);
    // 信噪比只有前端量得出（波形在它手里），但**判不判"太吵"是服务端的事**——
    // 门槛留在前端的话两边会各走各的，sure 的 0.5 就是这么在前端长出三份拷贝的。
    if (Number.isFinite(snrDb)) q.set('snr', String(snrDb));
    const r = await fetch(`/api/pronounce?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: wav,
    });
    const body: unknown = await r.json().catch(() => null);
    if (r.ok) return { ok: true, data: body as T.PronounceResult };
    const error = body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error) : `API ${r.status}`;
    return { ok: false, sidecarDown: r.status === 503, error };
  },

  // 搬家。导出走 j（失败只需要一句话），导入走 jx——服务端会说清"格式不对"还是
  // "来自更新的版本"，那两句用户需要看到原文。
  exportBackup: () => j<{ exportedAt: string } & Record<string, unknown>>(fetch('/api/backup')),
  importBackup: (data: unknown) => jx<{ added: number; skipped: number; cards: number }>(
    fetch('/api/backup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }),
  ),

  confusions: (word: string) => j<{ contrasts: T.Contrast[] }>(fetch(`/api/confusions/${encodeURIComponent(word)}`)),

  // 整机唯一的「当前用户」，服务端持有。切换是全站范围的事——网页切了，AI 那头
  // 读到的也跟着变，所以调用方切完要整页刷新，不是这三个方法自己的事。
  // 用 jx 不用 j：切错名字（404「没有叫「X」的用户」）、建重名（400「已经有「X」了」）
  // 是这两个端点最现实的出错路径，服务端写的中文就是给界面直接展示的，j() 会把它
  // 换成 `API 404` 这种不中文的占位文案——跟 addEntry 是同一个理由。
  user: () => j<T.UserInfo>(fetch('/api/user')),
  switchUser: (name: string) => jx<T.UserInfo>(fetch('/api/user', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })),
  createUser: (name: string) => jx<T.UserInfo>(fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })),
};
