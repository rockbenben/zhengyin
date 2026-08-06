import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function mwAudioUrl(audioName: string): string {
  let subdir: string;
  if (audioName.startsWith('bix')) subdir = 'bix';
  else if (audioName.startsWith('gg')) subdir = 'gg';
  else if (/^[^a-zA-Z]/.test(audioName)) subdir = 'number';
  else subdir = audioName[0];
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdir}/${audioName}.mp3`;
}

// 校验一个 key 能不能用：只发那次查词的元数据请求，不下载音频。设置页保存前先跑一遍，
// 用户当场就知道 key 对不对——否则只能等下一次讲词、发现音频还是合成音才反应过来。
// MW 对无效 key 返回的是 HTTP 200 + 纯文本 "Invalid API key..."，不是 4xx，所以必须看内容。
export async function verifyMwKey(
  apiKey: string, fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetchFn(
      `https://dictionaryapi.com/api/v3/references/collegiate/json/test?key=${encodeURIComponent(apiKey)}`,
    );
    if (!res.ok) return { ok: false, reason: `词典服务返回 HTTP ${res.status}` };
    const body = await res.text();
    if (/invalid api key/i.test(body)) return { ok: false, reason: '词典服务说这个 key 无效' };
    try {
      JSON.parse(body);
    } catch {
      return { ok: false, reason: '词典服务返回了非预期内容' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `连不上词典服务：${(e as Error).message}` };
  }
}

export async function fetchMwAudio(
  word: string, apiKey: string, destDir: string, fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  // 多用户后音频文件是全体用户共享的缓存：另一个人已经下过这个词，直接复用。
  // 这也顺带让离线时的「升级到真人音」不再白打一次注定失败的请求。
  const cached = `${slugify(word)}-mw.mp3`;
  if (existsSync(join(destDir, cached))) return cached;

  try {
    const res = await fetchFn(
      `https://dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(word)}?key=${apiKey}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as unknown[];
    const first = data.find((d) => typeof d === 'object' && d !== null) as any;
    const audioName: string | undefined = first?.hwi?.prs?.find((p: any) => p?.sound?.audio)?.sound?.audio;
    if (!audioName) return null;
    const audioRes = await fetchFn(mwAudioUrl(audioName));
    if (!audioRes.ok) return null;
    mkdirSync(destDir, { recursive: true });
    const file = `${slugify(word)}-mw.mp3`;
    writeFileSync(join(destDir, file), Buffer.from(await audioRes.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}
