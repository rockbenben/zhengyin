import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp, type AppDeps } from './app.js';
import { openDb, overallStats, putReferenceIpa, noteEvidence } from './db.js';
import { NoteStore } from './notes.js';
import { analyzeText } from './service.js';
import { ReviewStore } from './review.js';
import { CONFIDENT } from './analysis/espeak.js';
import { invalidUserName } from './users.js';

export function testDeps(): AppDeps {
  const notesDir = mkdtempSync(join(tmpdir(), 'notes-'));
  writeFileSync(join(notesDir, 'kl.md'), `---
id: kl-cluster
title: kl 连缀
triggers: [cluster-onset:kl]
severity: confirmed
---
不要加塞元音。
`, 'utf8');
  // **两个音素都声明**，跟真实的 l-vs-n 笔记一致。
  // 原来只写 phoneme:n（为了不让它连带命中 click、带偏 noteCount 断言），
  // 但那让 fixture 变得不真实：评测结果按**错误的那一对**匹配（替换是关于一对音的），
  // 只声明一边的笔记教不了 n→l 这个混淆，于是一堆用例在规则改对之后反而红了——
  // 红得对，是 fixture 假。click 那处 noteCount 相应改成 2。
  writeFileSync(join(notesDir, 'l-vs-n.md'), `---
id: l-vs-n
title: l/n 混淆
triggers: [phoneme:l, phoneme:n]
---
舌尖位置区分 l 和 n。
`, 'utf8');
  // words: 范围的笔记。加它是为了守住"评测结果里也要挂得上讲词的笔记"——
  // matchNotes 的第三个参数一度没传，于是这类笔记只在词条页出现，
  // 而你正好念错那个词的那一刻反倒不给。
  writeFileSync(join(notesDir, 'ine.md'), `---
id: ine-spelling
title: -ine 不都读 /aɪn/
triggers: []
words: [machine]
severity: confirmed
---
看拼写猜读音的陷阱。
`, 'utf8');
  // 词尾连缀的笔记。用来守"插入之后位置有没有错位"——ins 不消耗目标位置，
  // 消耗了的话它后面每个音读到的结构标签都会往后串一格。
  writeFileSync(join(notesDir, 'coda.md'), `---
id: coda-cluster
title: 词尾连缀
triggers: [cluster-coda:sk]
severity: confirmed
---
词尾两个辅音之间不许有元音。
`, 'utf8');
  const noteStore = new NoteStore(notesDir);
  noteStore.load();
  return {
    db: openDb(':memory:'),
    noteStore,
    audioDir: mkdtempSync(join(tmpdir(), 'audio-')),
    mwKey: 'TESTKEY',
    fetchMw: vi.fn().mockResolvedValue('click-mw.mp3'),
    synthTts: vi.fn().mockResolvedValue('x-tts.mp3'),
    now: () => '2026-07-28T00:00:00Z',
    review: new ReviewStore(join(mkdtempSync(join(tmpdir(), 'rev-')), 'review-state.json')),
    today: () => '2026-07-28',
    modelsDir: mkdtempSync(join(tmpdir(), 'models-')),
    envFile: join(mkdtempSync(join(tmpdir(), 'env-')), '.env'),
    root: process.cwd(),
    verifyMw: vi.fn().mockResolvedValue({ ok: true }),
    recognizePhonemes: vi.fn().mockResolvedValue({ reachable: true, ipa: 'n aɪ t', phones: null, reason: null }),
    checkPhonemeAsr: vi.fn().mockResolvedValue(true),
    // AppDeps 上这是必填的，漏了一直没人发现——server/tsconfig.json 把测试文件
    // exclude 掉了，于是服务端的测试**任何地方都不做类型检查**
    // （见 server/tsconfig.typecheck.json 那段注释）
    hasUv: true,
    profileFile: join(mkdtempSync(join(tmpdir(), 'profile-')), '发音档案.md'),
    users: {
      current: () => '默认',
      list: () => ['默认'],
      switchTo: vi.fn().mockReturnValue('ok' as const),
      create: vi.fn().mockReturnValue('ok' as const),
    },
  };
}

/** 建一个词条。注意别用下面那个 put()——它发的是 PUT，而 /api/entries 是 POST */
async function addEntry(app: ReturnType<typeof createApp>, text: string) {
  return app.request('/api/entries', {
    method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json' },
  });
}

async function put(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

/**
 * 一个英文字母都没有的输入，直接不建词条。
 *
 * 原来的路子是"先建、前端发现全都查不到再删"。那条路对 `.` 会走死：
 * 删词条走 DELETE /api/entries/<text>，`.` 在 URL 路径里是特殊段会被规范化掉，
 * 删不掉；而前端那次删还是静默的（.catch(() => {})）。结果是打一个 `.` 进去，
 * 界面告诉你「词典里没有」，库里却**永久**多一行，连它自己的删除按钮都点不动。
 * 这是查文案时拿垃圾输入试出来的，真复现了。
 */
describe('垃圾输入不能在库里留下删不掉的行', () => {
  it.each(['.', '..', '???', '123', '——'])('「%s」直接拒掉，不进库', async (junk) => {
    const app = createApp(testDeps());
    const res = await addEntry(app, junk);
    expect(res.status).toBe(400);
    const list = await (await app.request('/api/entries')).json();
    expect(list.entries, `「${junk}」还是被建出来了`).toHaveLength(0);
  });

  it('报错要说清这里该给什么，不是甩一句「无有效词」', async () => {
    const app = createApp(testDeps());
    const body = await (await addEntry(app, '???')).json();
    expect(body.error).toMatch(/英文单词|英文字母/);
  });

  it('正常的词照旧能建——别把守卫做成一堵墙', async () => {
    const app = createApp(testDeps());
    expect((await addEntry(app, 'click')).status).toBe(200);
    const list = await (await app.request('/api/entries')).json();
    expect(list.entries).toHaveLength(1);
  });
});

describe('health', () => {
  it('GET /api/health returns ok + mwConfigured', async () => {
    const res = await createApp(testDeps()).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mwConfigured: true });
  });

  it('GET /api/health reports mwConfigured=false when no key', async () => {
    const deps = testDeps();
    deps.mwKey = undefined;
    const res = await createApp(deps).request('/api/health');
    expect(await res.json()).toEqual({ ok: true, mwConfigured: false });
  });
});

describe('entries api', () => {
  it('POST creates entry with note hits and audio', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'Click' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.text).toBe('click');
    expect(d.words[0].ipa).toBe('ˈklɪk');
    expect(d.notes[0].id).toBe('kl-cluster');
    expect(d.audio[0]).toMatchObject({ source: 'mw', url: '/api/audio/click-mw.mp3' });
  });

  it('GET list + GET one + DELETE', async () => {
    const app = createApp(testDeps());
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    });
    const list = await (await app.request('/api/entries')).json();
    expect(list.entries).toHaveLength(1);
    // 列表那一列数的是**点进去真会摆出来的**那几篇，不是全部命中。
    // 还没在 click 上错过任何音，所以是 0——两篇沾了音的都收在折叠里。
    // 这里钉的是那条不变量：列表上的数字 === 词条页摆在外面的篇数。
    // 原来数全部命中，于是列上写「2 篇」、点进去一篇都没有；而笔记越攒越多差越大。
    const one = await app.request('/api/entries/click');
    expect(one.status).toBe(200);
    const detail = await one.clone().json();
    expect(detail.notes.length, 'click 该沾上 l-vs-n 和 kl-cluster 两篇').toBe(2);
    expect(list.entries[0].noteCount).toBe(detail.notes.filter((n: { relevant: boolean }) => n.relevant).length);
    expect(list.entries[0].noteCount).toBe(0);
    const del = await app.request('/api/entries/click', { method: 'DELETE' });
    expect((await del.json()).ok).toBe(true);
    expect((await app.request('/api/entries/click')).status).toBe(404);
  });

  it('缺词的 404 说清在不在词典——空状态那句承诺按它分叉', async () => {
    const app = createApp(testDeps());
    const inDict = await app.request('/api/entries/click');
    expect(inDict.status).toBe(404);
    expect((await inDict.json()).inDictionary, 'click 在词典里却报 false').toBe(true);
    const notIn = await app.request('/api/entries/anthropic');
    expect(notIn.status).toBe(404);
    expect((await notIn.json()).inDictionary, '生造词该是 false').toBe(false);
    // 短语口径跟 POST 一致：任一词查得到就算查得到
    const phrase = await app.request('/api/entries/black%20quorble');
    expect((await phrase.json()).inDictionary, '短语里 black 查得到，整条不该是 false').toBe(true);
  });

  // 上面那条只证了"没错过就是 0"。这条证它不是**永远**是 0——
  // 少了它，把 noteCount 写死成 0 也能全绿。
  it('讲这个词的笔记（words:）不用先错一次就算数，列表和词条页仍然同一个数', async () => {
    const app = createApp(testDeps());
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'machine' }),
      headers: { 'content-type': 'application/json' },
    });
    const list = await (await app.request('/api/entries')).json();
    const row = list.entries.find((e: { text: string }) => e.text === 'machine');
    const detail = await (await app.request('/api/entries/machine')).json();
    const shown = detail.notes.filter((n: { relevant: boolean }) => n.relevant);
    expect(shown.map((n: { id: string }) => n.id), '讲 machine 的那篇该摆在外面').toContain('ine-spelling');
    expect(row.noteCount, '列表上的数字必须等于点进去真会摆出来的篇数').toBe(shown.length);
    expect(row.noteCount).toBeGreaterThan(0);
  });

  it('POST falls back to tts when mw fails', async () => {
    const deps = testDeps();
    (deps.fetchMw as any).mockResolvedValue(null);
    const app = createApp(deps);
    const d = await (await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    })).json();
    expect(d.audio[0].source).toBe('tts');
  });

  it('GET/DELETE are case-insensitive against the lowercased stored key', async () => {
    const app = createApp(testDeps());
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'Click' }),
      headers: { 'content-type': 'application/json' },
    });
    const one = await app.request('/api/entries/Click');
    expect(one.status).toBe(200);
    const del = await app.request('/api/entries/Click', { method: 'DELETE' });
    expect((await del.json()).ok).toBe(true);
  });

  it('phrase POST creates per-word audio plus one phraseAudio row', async () => {
    const app = createApp(testDeps());
    const d = await (await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click click' }),
      headers: { 'content-type': 'application/json' },
    })).json();
    expect(d.phraseAudio).toMatchObject({ source: 'tts' });
  });

  it('POST 词条【不】建复习卡——查过 ≠ 要练', async () => {
    // 这条以前断言的是"录入即入列"。那正是复习队列被灌爆的原因：
    // 灌 33 个词进去，其中 26 个从没录过音，队列直接废掉。
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'click');
    expect(deps.review.due('2099-01-01')).toEqual([]);
  });

  it('DELETE entry removes its review card', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    });
    await app.request('/api/entries/click', { method: 'DELETE' });
    expect(deps.review.due('2026-07-29')).toEqual([]);
  });

  it('DELETE does not unlink an audio file still referenced by another entry sharing the same slug', async () => {
    const deps = testDeps();
    // slugify(word) is the filename, so two different entries that share a word (here:
    // "black cat" and "black") produce the exact same audio filename. fetchMw here writes
    // a real file per word so we can assert on disk state, not just the mock call.
    (deps.fetchMw as any).mockImplementation(async (word: string, _key: string, dir: string) => {
      const file = `${word}-mw.mp3`;
      writeFileSync(join(dir, file), 'fake-audio-bytes', 'utf8');
      return file;
    });
    const app = createApp(deps);
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'black cat' }),
      headers: { 'content-type': 'application/json' },
    });
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'black' }),
      headers: { 'content-type': 'application/json' },
    });
    const sharedFile = join(deps.audioDir, 'black-mw.mp3');
    expect(existsSync(sharedFile)).toBe(true);

    const del = await app.request(`/api/entries/${encodeURIComponent('black cat')}`, { method: 'DELETE' });
    expect((await del.json()).ok).toBe(true);

    // "black" still exists and still references black-mw.mp3 — the file must survive.
    expect(existsSync(sharedFile)).toBe(true);
    const remaining = await app.request('/api/entries/black');
    expect(remaining.status).toBe(200);
    const remainingJson = await remaining.json();
    expect(remainingJson.audio.some((a: any) => a.url === '/api/audio/black-mw.mp3')).toBe(true);
  });

  it('DELETE unlinks the audio file once no remaining entry references it', async () => {
    const deps = testDeps();
    (deps.fetchMw as any).mockImplementation(async (word: string, _key: string, dir: string) => {
      const file = `${word}-mw.mp3`;
      writeFileSync(join(dir, file), 'fake-audio-bytes', 'utf8');
      return file;
    });
    const app = createApp(deps);
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    });
    const file = join(deps.audioDir, 'click-mw.mp3');
    expect(existsSync(file)).toBe(true);
    await app.request('/api/entries/click', { method: 'DELETE' });
    expect(existsSync(file)).toBe(false);
  });

  /**
   * 合成音要能升级成真人录音。
   *
   * 原来的判断是"这个词有没有音频行"，命中就 continue——于是一个词只要落过一次合成音，
   * 之后**永远**不会再去试真人录音，哪怕后来配好了 key、哪怕词典里明明有。
   * 实测在真实库里踩到了：black cat click glass light night 六个词卡在 TTS，
   * 而这六个词 MW 全都有真人录音。
   *
   * 而且它不只是音质问题：referenceBaseline() 只认 source==='mw'，所以这些词的评测
   * 永久走词典基准——正是模型元音偏置那条退路。click 恰好是练得最多的那个词。
   */
  it('先落了合成音，之后配上 key 再 POST → 升级成真人录音，旧文件清掉', async () => {
    const deps = testDeps();
    deps.mwKey = undefined;                       // 一开始没有 key
    (deps.synthTts as any).mockImplementation(async (word: string, dir: string) => {
      const file = `${word}-tts.mp3`;
      writeFileSync(join(dir, file), 'tts-bytes', 'utf8');
      return file;
    });
    (deps.fetchMw as any).mockImplementation(async (word: string, _key: string, dir: string) => {
      const file = `${word}-mw.mp3`;
      writeFileSync(join(dir, file), 'mw-bytes', 'utf8');
      return file;
    });
    const app = createApp(deps);
    const post = () => app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'light' }),
      headers: { 'content-type': 'application/json' },
    });

    const first = await (await post()).json();
    expect(first.audio[0].source).toBe('tts');
    expect(existsSync(join(deps.audioDir, 'light-tts.mp3'))).toBe(true);

    deps.mwKey = 'key-now-configured';            // 用户去设置页配上了 key
    const second = await (await post()).json();
    expect(second.audio).toHaveLength(1);         // 不许留下两行
    expect(second.audio[0].source).toBe('mw');
    expect(existsSync(join(deps.audioDir, 'light-mw.mp3'))).toBe(true);
    // 旧的合成音没人再引用了，该清掉，不然攒一堆没用的 mp3
    expect(existsSync(join(deps.audioDir, 'light-tts.mp3'))).toBe(false);
  });

  it('已经是真人录音时不再白跑 MW，也不重复插行', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(deps.fetchMw).toHaveBeenCalledTimes(1);
    const again = await (await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    })).json();
    expect(deps.fetchMw).toHaveBeenCalledTimes(1);   // 没有第二次
    expect(again.audio).toHaveLength(1);
  });

  it('升级时 MW 又失败了 → 保住原来的合成音，不能删了旧的却没有新的', async () => {
    // 这是最要命的一种改坏法：把一个能听的音频换成 404。
    const deps = testDeps();
    deps.mwKey = undefined;
    (deps.synthTts as any).mockImplementation(async (word: string, dir: string) => {
      const file = `${word}-tts.mp3`;
      writeFileSync(join(dir, file), 'tts-bytes', 'utf8');
      return file;
    });
    const app = createApp(deps);
    const post = () => app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'light' }),
      headers: { 'content-type': 'application/json' },
    });
    await post();

    deps.mwKey = 'key';
    (deps.fetchMw as any).mockResolvedValue(null);    // 配了 key，但词典里没有 / 请求失败
    const after = await (await post()).json();
    expect(after.audio).toHaveLength(1);
    expect(after.audio[0].source).toBe('tts');
    expect(existsSync(join(deps.audioDir, 'light-tts.mp3'))).toBe(true);
  });

  it('升级时不许删掉别的词条还在用的那个文件', async () => {
    // 文件名来自 slugify(word)，所以 "black cat" 里的 black 和单独的词条 "black"
    // 都落到 black-tts.mp3。升级 "black" 时如果无条件 unlink 旧文件，
    // "black cat" 那个词条的音频就永久 404 了。
    // 这一条是变异测试逼出来的：「旧文件无条件 unlink」当时活了下来，说明没人守这个场景。
    const deps = testDeps();
    deps.mwKey = undefined;
    (deps.synthTts as any).mockImplementation(async (word: string, dir: string) => {
      const file = `${word.replace(/ /g, '-')}-tts.mp3`;
      writeFileSync(join(dir, file), 'tts-bytes', 'utf8');
      return file;
    });
    (deps.fetchMw as any).mockImplementation(async (word: string, _k: string, dir: string) => {
      const file = `${word}-mw.mp3`;
      writeFileSync(join(dir, file), 'mw-bytes', 'utf8');
      return file;
    });
    const app = createApp(deps);
    const post = (text: string) => app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text }),
      headers: { 'content-type': 'application/json' },
    });

    await post('black cat');            // 造出 black-tts.mp3（"black cat" 在引用它）
    await post('black');                // 单独的词条也引用同一个 black-tts.mp3
    const shared = join(deps.audioDir, 'black-tts.mp3');
    expect(existsSync(shared)).toBe(true);

    deps.mwKey = 'key';
    await post('black');                // 只升级 "black" 这个词条
    expect(existsSync(join(deps.audioDir, 'black-mw.mp3'))).toBe(true);
    // "black cat" 还在引用它，绝不能删
    expect(existsSync(shared)).toBe(true);
    // 而 "black cat" 那边确实还指着它
    const bc = await (await app.request('/api/entries/black%20cat')).json();
    expect(bc.audio.find((a: any) => a.word === 'black').url).toContain('black-tts.mp3');
  });

  it('没有 key 时不动已有的合成音（别删了换个更差的）', async () => {
    const deps = testDeps();
    deps.mwKey = undefined;
    (deps.synthTts as any).mockImplementation(async (word: string, dir: string) => {
      const file = `${word}-tts.mp3`;
      writeFileSync(join(dir, file), 'tts-bytes', 'utf8');
      return file;
    });
    const app = createApp(deps);
    const post = () => app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'light' }),
      headers: { 'content-type': 'application/json' },
    });
    await post();
    (deps.synthTts as any).mockClear();
    const again = await (await post()).json();
    expect(deps.synthTts).not.toHaveBeenCalled();     // 也不该重新合成一遍
    expect(again.audio).toHaveLength(1);
    expect(again.audio[0].source).toBe('tts');
  });

  it('phrase with a repeated word only fetches and stores audio once for that word', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const d = await (await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'so so' }),
      headers: { 'content-type': 'application/json' },
    })).json();
    const soAudio = d.audio.filter((a: any) => a.word === 'so');
    expect(soAudio).toHaveLength(1);
    expect(deps.fetchMw).toHaveBeenCalledTimes(1);
  });

  it('POST with malformed JSON body returns 400, not a 500 stack trace', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/entries', {
      method: 'POST', body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
});

/** 连续的日期。原来是手拼 `2026-01-0${i+2}`，答对次数一多就拼出 2026-01-010 */
const day = (i: number) => `2026-01-${String(i + 2).padStart(2, '0')}`;

describe('review api', () => {
  it('GET /api/review/due 只给到期的，且带上是不是收藏的', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'click');
    // 复习卡不再由录入词条产生（查过 ≠ 要练），这里显式建一张，
    // 让下面要验的复习行为本身仍然被覆盖到。
    deps.review.addCard('click', '2026-07-28');
    expect((await (await app.request('/api/review/due')).json()).cards).toEqual([]);
    deps.today = () => '2026-07-29';
    expect((await (await app.request('/api/review/due')).json()).cards)
      .toEqual([{ text: 'click', due: '2026-07-29', starred: false }]);
  });

  it('POST /api/review/:text grades and returns the new CardState', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'click');
    // 复习卡不再由录入词条产生（查过 ≠ 要练），这里显式建一张，
    // 让下面要验的复习行为本身仍然被覆盖到。
    deps.review.addCard('click', '2026-07-28');
    deps.today = () => '2026-07-29';
    const res = await app.request('/api/review/click', {
      method: 'POST', body: JSON.stringify({ grade: 'remembered' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    // 响应形状加了 graduated：顶级又答对时卡片会出列，前端得能区分这两种情况。
    // 连对两次才升档，所以这一次留在 0 档、只把连胜记成 1，下次到期是明天。
    expect(await res.json()).toEqual({
      graduated: false,
      card: { rung: 0, due: '2026-07-30', lastReviewed: '2026-07-29', starred: false, streak: 1 },
    });
  });

  it('POST /api/review/:text on unknown card → 404', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/review/nope', {
      method: 'POST', body: JSON.stringify({ grade: 'remembered' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/review/:text rejects any grade that is not remembered/forgot', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'click');
    // 复习卡不再由录入词条产生（查过 ≠ 要练），这里显式建一张，
    // 让下面要验的复习行为本身仍然被覆盖到。
    deps.review.addCard('click', '2026-07-28');
    deps.today = () => '2026-07-29';
    // 'fuzzy' 曾经是合法值（经典 SRS 那个自评的"有点难"）。这个应用的评价由逐音素
    // 评测判、不是自己报的，它没有出处，已经去掉——列在这里免得哪天又被顺手加回来。
    for (const badBody of [{ grade: 'REMEMBERED' }, {}, { grade: null }, { grade: 123 }, { grade: 'good' }, { grade: 'fuzzy' }]) {
      const res = await app.request('/api/review/click', {
        method: 'POST', body: JSON.stringify(badBody),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    // and the card must be untouched by all of the above — still at rung 0.
    // 连对两次才升档，所以这里不能拿 rung 当判据（它这时恒为 0，证不出东西）。
    // 看连胜：答对一次读出 1 就说明起点干净；上面哪一条要是真被受理了，这里会是 2。
    const okRes = await app.request('/api/review/click', {
      method: 'POST', body: JSON.stringify({ grade: 'remembered' }),
      headers: { 'content-type': 'application/json' },
    });
    expect((await okRes.json()).card.streak).toBe(1);
  });

  it('POST /api/review/:text with malformed JSON body returns 400, not a 500 stack trace', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/review/click', {
      method: 'POST', body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('POST /api/review/:text distinguishes a genuine failure (disk write error) from "no such card"', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'click');
    // 复习卡不再由录入词条产生（查过 ≠ 要练），这里显式建一张，
    // 让下面要验的复习行为本身仍然被覆盖到。
    deps.review.addCard('click', '2026-07-28');
    // Card exists in review state at this point. Blow away the directory review-state.json
    // lives in so the *next* save() fails with a disk-write error — distinct from "no card".
    rmSync(dirname((deps.review as any).file), { recursive: true, force: true });
    const res = await app.request('/api/review/click', {
      method: 'POST', body: JSON.stringify({ grade: 'remembered' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toBe('无此卡片');
  });
});

describe('notes api', () => {
  it('GET /api/notes groups by severity', async () => {
    const app = createApp(testDeps());
    const d = await (await app.request('/api/notes')).json();
    // 断言的是**分组**，不是顺序。原来锁 confirmed[0].id，于是往 fixture 里多加一篇
    // 笔记就假红——而这条用例的名字和意图都跟排在第几位无关。
    //
    // 分到哪一组现在由**使用者自己的评测记录**决定（severityOf），不再读 frontmatter。
    // 这个库是空的，所以全部落在「资料」那一组——这正是全新装上的人该看到的样子。
    expect(d.groups.info.map((n: { id: string }) => n.id).sort())
      .toEqual(['coda-cluster', 'ine-spelling', 'kl-cluster', 'l-vs-n']);
    expect(d.groups.confirmed).toEqual([]);
    expect(d.groups.watch).toEqual([]);
  });

  it('GET /api/notes/:id returns markdown and examples', async () => {
    const app = createApp(testDeps());
    await app.request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'click' }),
      headers: { 'content-type': 'application/json' },
    });
    const d = await (await app.request('/api/notes/kl-cluster')).json();
    expect(d.markdown).toContain('加塞');
    expect(d.examples).toEqual(['click']);
  });

  it('unknown id → 404', async () => {
    const app = createApp(testDeps());
    expect((await app.request('/api/notes/nope')).status).toBe(404);
  });
});

function postAsr(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/asr', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('asr api', () => {
  it('single-word mishear (equal word counts) diffs the pair and hits l-vs-n note', async () => {
    const app = createApp(testDeps());
    const res = await postAsr(app, { target: 'light', heard: 'night' });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.match).toBe(false);
    expect(d.subs).toEqual([{ targetIpa: 'l', heardIpa: 'n' }]);
    expect(d.notes.map((n: any) => n.id)).toContain('l-vs-n');
  });

  it('multi-word phrase with equal word counts diffs word-by-word', async () => {
    const app = createApp(testDeps());
    const res = await postAsr(app, { target: 'quite light', heard: 'quite night' });
    const d = await res.json();
    expect(d.match).toBe(false);
    // "quite"/"quite" contributes no sub; only the second aligned pair (light/night) does.
    expect(d.subs).toEqual([{ targetIpa: 'l', heardIpa: 'n' }]);
    expect(d.notes.map((n: any) => n.id)).toContain('l-vs-n');
  });

  it('match:true (after trim+lowercase normalization) with no subs', async () => {
    const app = createApp(testDeps());
    const res = await postAsr(app, { target: 'Light', heard: ' light ' });
    const d = await res.json();
    expect(d.match).toBe(true);
    expect(d.subs).toEqual([]);
    expect(d.notes).toEqual([]);
  });

  it('mismatched word counts: diffs only the aligned positional pairs, ignoring extras', async () => {
    const app = createApp(testDeps());
    // heard has a trailing extra word beyond target's length; position-0 pair
    // (light/light) aligns and is identical, so no spurious sub is produced
    // from the unaligned extra word.
    const res = await postAsr(app, { target: 'light', heard: 'light there' });
    const d = await res.json();
    expect(d.match).toBe(false); // full-string comparison still differs
    expect(d.subs).toEqual([]);
    expect(d.notes).toEqual([]);
  });

  it('mismatched word counts: target longer than heard only diffs the aligned prefix', async () => {
    const app = createApp(testDeps());
    // target has 2 words, heard has 1: only pair 0 (quite/night) aligns positionally;
    // target's second word ("light") is not compared against anything.
    const res = await postAsr(app, { target: 'quite light', heard: 'night' });
    const d = await res.json();
    expect(d.match).toBe(false);
    expect(d.subs).toHaveLength(1);
  });

  it('unknown word (absent from CMUdict) never 500s — returns empty subs/notes', async () => {
    const app = createApp(testDeps());
    const res = await postAsr(app, { target: 'light', heard: 'zzxxqq' });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.match).toBe(false);
    expect(d.subs).toEqual([]);
    expect(d.notes).toEqual([]);
  });

  it('400 when target is missing/empty', async () => {
    const app = createApp(testDeps());
    const res = await postAsr(app, { heard: 'light' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('400 when heard is missing/empty', async () => {
    const app = createApp(testDeps());
    const res = await postAsr(app, { target: 'light', heard: '  ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('400 on malformed JSON body, not a 500 stack trace', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/asr', {
      method: 'POST', body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
});

describe('confusions api', () => {
  it('GET /api/confusions/:word returns candidates shape (route wiring; phoneme-level ' +
     'correctness is covered by analysis/confusions.test.ts against real note fixtures)', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/confusions/light');
    expect(res.status).toBe(200);
    const body = await res.json();
    // testDeps 的 l-vs-n 笔记只声明 phoneme:n（见 testDeps 里的注释），推不出 l→n，
    // 所以这里只校验形状与字段齐全，具体内容交给 confusions.test.ts。
    expect(Array.isArray(body.contrasts)).toBe(true);
    for (const c of body.contrasts) {
      expect(c).toEqual({
        word: expect.any(String), index: expect.any(Number),
        targetIpa: expect.any(String), partnerIpa: expect.any(String),
      });
    }
  });

  it('a word not in CMUdict → { contrasts: [] }, never 500s', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/confusions/zzxxqq');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contrasts: [] });
  });
});

describe('model api', () => {
  it('GET /api/model/:file serves an existing model file from modelsDir', async () => {
    const deps = testDeps();
    writeFileSync(join(deps.modelsDir, 'vosk-model-small-en-us-0.15.tar.gz'), 'fake-model-bytes', 'utf8');
    const app = createApp(deps);
    const res = await app.request('/api/model/vosk-model-small-en-us-0.15.tar.gz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fake-model-bytes');
  });

  it('GET /api/model/:file → 404 when the file does not exist', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/model/vosk-model-small-en-us-0.15.tar.gz');
    expect(res.status).toBe(404);
  });

  it('GET /api/model/:file → 400 rejects path traversal / unexpected filenames', async () => {
    const app = createApp(testDeps());
    expect((await app.request('/api/model/..%2f..%2fetc%2fpasswd')).status).toBe(400);
    expect((await app.request('/api/model/model.exe')).status).toBe(400);
  });
});

describe('settings: MW_API_KEY', () => {
  it('reports configured state without ever echoing the full key', async () => {
    const deps = testDeps();
    deps.mwKey = 'abcd1234-efgh-5678';
    const res = await createApp(deps).request('/api/settings/mw-key');
    const j = await res.json();
    expect(j.configured).toBe(true);
    expect(j.masked).toBe('••••5678');
    expect(JSON.stringify(j)).not.toContain('abcd1234');   // 完整密钥绝不回显
  });

  // 保存后必须**当场生效**：mwKey 在 /api/health 和录入 handler 里都是请求时才读的。
  // 只写 .env 不改 deps 的话，用户会看到告警消失、音频却还是合成音——比不改更糟。
  it('applies a saved key immediately, without a restart', async () => {
    const deps = testDeps();
    deps.mwKey = undefined;
    const app = createApp(deps);
    expect((await (await app.request('/api/health')).json()).mwConfigured).toBe(false);

    const res = await put(app, '/api/settings/mw-key', { key: 'new-key-9999' });
    expect(res.status).toBe(200);
    expect((await res.json()).masked).toBe('••••9999');
    expect(deps.mwKey).toBe('new-key-9999');
    expect((await (await app.request('/api/health')).json()).mwConfigured).toBe(true);
    expect(readFileSync(deps.envFile, 'utf8')).toContain('MW_API_KEY=new-key-9999');
  });

  it('preserves other lines already in .env', async () => {
    const deps = testDeps();
    writeFileSync(deps.envFile, '# 我自己的注释\nOTHER_VAR=keepme\nMW_API_KEY=old\n', 'utf8');
    await put(createApp(deps), '/api/settings/mw-key', { key: 'brand-new' });
    const text = readFileSync(deps.envFile, 'utf8');
    expect(text).toContain('# 我自己的注释');
    expect(text).toContain('OTHER_VAR=keepme');
    expect(text).toContain('MW_API_KEY=brand-new');
    expect(text).not.toContain('MW_API_KEY=old');
  });

  it('rejects a key the dictionary service refuses, leaving .env and mwKey untouched', async () => {
    const deps = testDeps();
    deps.mwKey = 'previous';
    deps.verifyMw = vi.fn().mockResolvedValue({ ok: false, reason: '词典服务说这个 key 无效' });
    const res = await put(createApp(deps), '/api/settings/mw-key', { key: 'bogus' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('无效');
    expect(deps.mwKey).toBe('previous');
    expect(existsSync(deps.envFile)).toBe(false);
  });

  it('skips verification when asked (offline)', async () => {
    const deps = testDeps();
    deps.verifyMw = vi.fn();
    const res = await put(createApp(deps), '/api/settings/mw-key', { key: 'unchecked', verify: false });
    expect(res.status).toBe(200);
    expect(deps.verifyMw).not.toHaveBeenCalled();
  });

  it.each([
    ['空 key', { key: '   ' }],
    ['缺字段', {}],
    ['带换行（会写坏 .env）', { key: 'a\nOTHER=x' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await put(createApp(testDeps()), '/api/settings/mw-key', body);
    expect(res.status).toBe(400);
  });

  it('clears the key and drops it from .env', async () => {
    const deps = testDeps();
    writeFileSync(deps.envFile, 'OTHER_VAR=keepme\nMW_API_KEY=live\n', 'utf8');
    deps.mwKey = 'live';
    const app = createApp(deps);
    const res = await app.request('/api/settings/mw-key', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(deps.mwKey).toBeUndefined();
    const text = readFileSync(deps.envFile, 'utf8');
    expect(text).not.toContain('MW_API_KEY');
    expect(text).toContain('OTHER_VAR=keepme');
    expect((await (await app.request('/api/health')).json()).mwConfigured).toBe(false);
  });
});

describe('GET/PUT /api/settings/model', () => {
  it('默认返回清单里的 default，且列出全部候选', async () => {
    const app = createApp(testDeps());
    const res = await app.request('/api/settings/model');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.selected).toBe('large');
    expect(body.file).toBe('vosk-model-en-us-0.22-lgraph.tar.gz');
    expect(body.options.map((o: { id: string }) => o.id).sort()).toEqual(['large', 'small']);
  });

  it('切换后写进 .env，GET 也跟着变', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const res = await app.request('/api/settings/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'small' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).file).toBe('vosk-model-small-en-us-0.15.tar.gz');
    expect(readFileSync(deps.envFile, 'utf8')).toContain('VOSK_MODEL=small');
    expect((await (await app.request('/api/settings/model')).json()).selected).toBe('small');
  });

  it('未知 id 一律 400，绝不静默退回默认值', async () => {
    // 静默退回是真会咬人的：用户点了「大模型」，界面显示成功、实际还在用小模型，
    // 于是继续抱怨"说什么都判对"，却查不出原因。
    const deps = testDeps();
    const app = createApp(deps);
    for (const id of ['medium', '', '../../etc/passwd']) {
      const res = await app.request('/api/settings/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      expect(res.status).toBe(400);
    }
    // 一次都没写进去
    expect(existsSync(deps.envFile) ? readFileSync(deps.envFile, 'utf8') : '').not.toContain('VOSK_MODEL');
  });

  it('id 不是字符串（数字/对象/缺失）也走 400，不是崩', async () => {
    const app = createApp(testDeps());
    for (const body of ['{"id":1}', '{"id":{}}', '{}', 'not json']) {
      const res = await app.request('/api/settings/model', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
      });
      expect(res.status).toBe(400);
    }
  });
});

/**
 * 「这条错误值不值得为它写一篇笔记」只能有**一处判据**。
 * 之前统计页自己用 notes.length === 0 另判了一遍，于是同一句「这些音反复出错」
 * 在发音档案里是 2 条、在统计页上是 14 条——同一个问题两个答案。
 */
/**
 * 笔记算不算「你的短板」，**由你的数据说了算，不由笔记自己声明**。
 *
 * severity 一度写在每篇笔记的 frontmatter 里。那是写笔记的人对读者的断言——
 * 别人克隆这个仓库，看到的是前一个使用者的判定，界面上还写着「已确认的短板」，
 * 对他就是句假话——短板因人而异，同一个音别人未必有问题。
 */
describe('笔记档次按使用者自己的记录推', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  async function record(deps: AppDeps, word: string, heard: string) {
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: heard, phones: null, reason: null });
    await createApp(deps).request(`/api/pronounce?target=${word}&snr=35`, { method: 'POST', body: wav });
  }

  async function severityOfNote(deps: AppDeps, id: string) {
    const d = await (await createApp(deps).request('/api/notes')).json();
    for (const g of ['confirmed', 'watch', 'info'] as const) {
      if (d.groups[g].some((n: { id: string }) => n.id === id)) return g;
    }
    return null;
  }

  it('全新的库：一篇都不算短板，全是资料', async () => {
    const deps = testDeps();
    const d = await (await createApp(deps).request('/api/notes')).json();
    expect(d.groups.confirmed).toEqual([]);
    expect(d.groups.watch).toEqual([]);
    expect(d.groups.info.length).toBeGreaterThan(0);
  });

  it('命中过但不够 → 待观察', async () => {
    const deps = testDeps();
    // l-vs-n 的 trigger 是 phoneme:n；只在一个词上错两次
    await record(deps, 'night', 'l aɪ t');
    await record(deps, 'night', 'l aɪ t');
    expect(await severityOfNote(deps, 'l-vs-n')).toBe('watch');
  });

  it('次数够但全在一个词上 → 仍然只是待观察', async () => {
    // 这一条是分水岭。只测"次数不够"的话，把跨词那半条判据删掉照样绿——
    // 而跨词复现正是"你的发音习惯"和"那一次录音的问题"之间最可靠的分界线。
    const deps = testDeps();
    for (let i = 0; i < 5; i++) await record(deps, 'night', 'l aɪ t');
    expect(await severityOfNote(deps, 'l-vs-n')).toBe('watch');
  });

  it('≥3 次且跨 ≥2 个词 → 已确认的短板', async () => {
    const deps = testDeps();
    await record(deps, 'night', 'l aɪ t');
    await record(deps, 'name', 'l eɪ m');
    await record(deps, 'nine', 'l aɪ n');
    expect(await severityOfNote(deps, 'l-vs-n')).toBe('confirmed');
  });

  it('别人的笔记不会因为我练过就升档——只有真命中的那篇会动', async () => {
    const deps = testDeps();
    await record(deps, 'night', 'l aɪ t');
    await record(deps, 'name', 'l eɪ m');
    await record(deps, 'nine', 'l aɪ n');
    // kl-cluster 一次都没命中过，照旧是资料
    expect(await severityOfNote(deps, 'kl-cluster')).toBe('info');
  });

  // ── 讲词的笔记（words:）不要求跨词 ──
  //
  // 它讲的就是那几个词，**没有泛化主张可提**，要求它"不止在一个词上出现"是
  // 结构上不可能满足的。实测后果：dopamine 那篇命中 70 次（全库最高），却顶着
  // 素材库那行「还没在你身上出现过，或者出现得还不够」——那句话是假的。
  it('讲词的笔记：≥3 次就算，不要求跨词', async () => {
    const deps = testDeps();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'byword.md'), `---
id: byword
title: night 这个词自己的坑
words: [night]
---
## 自检法
对着镜子看。

## 对比训练
脑 / 老。
`, 'utf8');
    deps.noteStore.load();
    for (let i = 0; i < 3; i++) await record(deps, 'night', 'l aɪ t');
    expect(await severityOfNote(deps, 'byword'), '讲词的笔记被跨词那条挡住了').toBe('confirmed');
  });

  it('讲词的笔记不够 3 次照样只是待观察——放宽的只有跨词那一半', async () => {
    const deps = testDeps();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'byword.md'), `---
id: byword
title: night 这个词自己的坑
words: [night]
---
## 自检法
对着镜子看。

## 对比训练
脑 / 老。
`, 'utf8');
    deps.noteStore.load();
    for (let i = 0; i < 2; i++) await record(deps, 'night', 'l aɪ t');
    expect(await severityOfNote(deps, 'byword')).toBe('watch');
  });

  it('frontmatter 里写 severity 也没用，不读它', async () => {
    const deps = testDeps();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'liar.md'), `---
id: liar
title: 自称已确认
triggers: [phoneme:z]
severity: confirmed
---
我在 frontmatter 里说自己是已确认的短板。
`, 'utf8');
    deps.noteStore.load();
    // 没有任何证据 → 仍然只是资料
    expect(await severityOfNote(deps, 'liar')).toBe('info');
  });
});

describe('GET /api/stats 的 worthANote', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  async function record(deps: AppDeps, word: string, heard: string) {
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: heard, phones: null, reason: null });
    await createApp(deps).request(`/api/pronounce?target=${word}&snr=35`, { method: 'POST', body: wav });
  }

  it('够门槛（≥3 次、跨 ≥2 个词）才标 worthANote', async () => {
    const deps = testDeps();
    // thin /θɪn/ 的 θ 发成 s：两次在 thin，一次在 thought → 3 次、2 个词
    await record(deps, 'thin', 's ɪ n');
    await record(deps, 'thin', 's ɪ n');
    await record(deps, 'thought', 's ɔ t');
    const d = await (await createApp(deps).request('/api/stats')).json();
    const row = d.phonemes.find((r: { targetIpa: string; heardIpa: string }) =>
      r.targetIpa === 'θ' && r.heardIpa === 's');
    expect(row, 'θ→s 那一行没出现').toBeDefined();
    expect(row.count).toBe(3);
    expect(row.worthANote).toBe(true);
  });

  it('只在一个词上、而且整条转写都崩了 → 不标', async () => {
    // 「那次录音本身就崩了」的样子。只有一处错的话反而是**真信号**——
    // 见下一条，以及 /ɑ/→/æ/ 那个真实案例。
    const deps = testDeps();
    for (let i = 0; i < 5; i++) await record(deps, 'thin', 's æ ŋ k');
    const d = await (await createApp(deps).request('/api/stats')).json();
    const row = d.phonemes.find((r: { targetIpa: string }) => r.targetIpa === 'θ');
    expect(row.count).toBe(5);
    expect(row.worthANote).toBe(false);
  });

  it('统计页和发音档案对"有没有笔记"必须给同一个答案', async () => {
    // 这一条守的是**两处不许各答各的**。判据抽成 notesCovering 之前，
    // /api/stats 里有自己的一份（只要沾上一个音素就算覆盖），于是
    // /n/→/ŋ/ 在统计页上被 l-vs-n 认领、在档案里却是"该补"——同一个问题两个答案。
    // 这个仓库已经在 sure 的 0.5、worthANote 上各栽过一次了。
    const deps = testDeps();
    // l-vs-n 只声明 phoneme:n，所以 n→ŋ 这条替换**不该**算它覆盖
    for (const w of ['night', 'name']) await record(deps, w, 'ŋ aɪ t');
    await record(deps, 'nine', 'ŋ aɪ n');

    const stats = await (await createApp(deps).request('/api/stats')).json();
    const row = stats.phonemes.find((r: { targetIpa: string; heardIpa: string }) =>
      r.targetIpa === 'n' && r.heardIpa === 'ŋ');
    expect(row, 'n→ŋ 那一行没出现').toBeDefined();
    expect(row.notes, '统计页把 n→ŋ 算成有笔记了——而 l-vs-n 只讲了 l 和 n').toEqual([]);
    // 既然没笔记、又够门槛，它就该被标成"该补"
    expect(row.worthANote).toBe(true);
  });

  it('已经有笔记的不标——那不是缺口', async () => {
    const deps = testDeps();
    // **替换错要两边都覆盖到**（profile.ts 的 notesCovering）。testDeps 里的
    // l-vs-n 只声明了 phoneme:n（那是为了不误伤用 click 的其他用例），
    // 所以这里另写一篇真的把 l 和 n 都讲到的——真实的 l-vs-n 笔记正是这样。
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'ln-pair.md'), `---
id: ln-pair
title: l 和 n
triggers: [phoneme:l, phoneme:n]
---
两个都讲。
`, 'utf8');
    deps.noteStore.load();
    await record(deps, 'night', 'l aɪ t');
    await record(deps, 'name', 'l eɪ m');
    await record(deps, 'nine', 'l aɪ n');
    const d = await (await createApp(deps).request('/api/stats')).json();
    const row = d.phonemes.find((r: { targetIpa: string }) => r.targetIpa === 'n');
    expect(row.notes.length).toBeGreaterThan(0);
    expect(row.worthANote).toBe(false);
  });
});

/**
 * 参考基准（模型转写真人录音）是这个工具的主要判据。它存在的理由是抵消模型偏置——
 * book 的 /ʊ/ 被模型听成 /æ/，母语者和你都被听成 /æ/，两边抵消。
 *
 * 但它有个**没被检查过的前提**：模型对那段真人录音的转写是可信的。实测 dopamine 不可信：
 * 7 个音里差 3 个（全库最差，其余 11 个词差 0–1 个），其中第 5 位词典是 /i/、基准是 /eɪ/，
 * 而使用者 15 次里发出 /i/ 十次——**他念对了，却被判错 11 次**。
 * 而 dopamine 正是他练了 36 次、全对率 3% 的那个词。
 */
describe('参考基准的可信度', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  /** 让 night 有一条 MW 参考音，并指定模型对它的转写 */
  async function withBaseline(deps: AppDeps, refIpa: string) {
    await createApp(deps).request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text: 'night' }),
      headers: { 'content-type': 'application/json' },
    });
    // fetchMw 的桩一律返回 click-mw.mp3，所以参考转写要挂在那个文件名上
    putReferenceIpa(deps.db, 'click-mw.mp3', refIpa, deps.now());
  }

  async function say(deps: AppDeps, heard: string) {
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: heard, phones: null, reason: null });
    return (await createApp(deps).request('/api/pronounce?target=night&snr=35', { method: 'POST', body: wav })).json();
  }

  it('基准跟词典的差异要如实报出来', async () => {
    const deps = testDeps();
    await withBaseline(deps, 'n eɪ t');          // 词典是 n aɪ t，差第 1 位
    const body = await say(deps, 'n aɪ t');
    expect(body.comparedWith).toBe('reference');
    expect(body.baselineDrift).toEqual([1]);
  });

  it('基准跟词典一致时，drift 是空的', async () => {
    const deps = testDeps();
    await withBaseline(deps, 'n aɪ t');
    expect((await say(deps, 'n aɪ t')).baselineDrift).toEqual([]);
  });

  it('反复发出词典那个值 → 纠正基准，并说出来', async () => {
    // 这就是 dopamine 第 5 位的情形：基准说 eɪ，而他一遍遍发出词典的 aɪ。
    // 念对了却被判错，是这个工具最坏的一种错。
    const deps = testDeps();
    await withBaseline(deps, 'n eɪ t');
    for (let i = 0; i < 3; i++) await say(deps, 'n aɪ t');
    const body = await say(deps, 'n aɪ t');
    expect(body.baselineRepaired).toHaveLength(1);
    expect(body.baselineRepaired[0]).toMatchObject({ index: 1, from: 'eɪ', to: 'aɪ' });
    // 纠正之后这一次就该判对了
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
  });

  it('证据不够 → 不纠正。基准可能是对的，是他分不清', async () => {
    const deps = testDeps();
    await withBaseline(deps, 'n eɪ t');
    await say(deps, 'n aɪ t');                    // 只有 1 次
    const body = await say(deps, 'n aɪ t');       // 第 2 次
    expect(body.baselineRepaired).toEqual([]);
  });

  it('两边都发过、基准那边更多 → 不纠正', async () => {
    // 这一条是分水岭。上一条他从没发出过词典值，dictHits=0 自然不纠正；
    // 真正要守的是"词典值也发过几次，但基准值发得更多"——那说明基准是对的，
    // 只纠正**证据压倒性**的位置。去掉 dictHits > baseHits 这半条判据，
    // 基准抵消模型偏置的用处就毁了（book 的 ʊ→æ 会被"纠正"回 ʊ，然后天天判错）。
    const deps = testDeps();
    await withBaseline(deps, 'n eɪ t');
    for (let i = 0; i < 4; i++) await say(deps, 'n eɪ t');   // 基准值 4 次
    for (let i = 0; i < 3; i++) await say(deps, 'n aɪ t');   // 词典值 3 次（够 REPAIR_MIN 但不占优）
    const body = await say(deps, 'n aɪ t');
    expect(body.baselineRepaired, '基准值更多时不该纠正').toEqual([]);
  });

  it('他发的跟基准一致时 → 不纠正，那正是基准在干活', async () => {
    // book 的 ʊ→æ 就是这种：模型对母语者和对你都听成 æ，两边抵消才是它的用处
    const deps = testDeps();
    await withBaseline(deps, 'n eɪ t');
    for (let i = 0; i < 5; i++) await say(deps, 'n eɪ t');
    const body = await say(deps, 'n eɪ t');
    expect(body.baselineRepaired).toEqual([]);
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
  });
});

/**
 * 词条页上「哪几篇跟这个词有关」。
 *
 * 只看"这个词里有没有这个音"不够：dopamine 里有 /n/，于是 l-vs-n 也挂上来了——
 * 而这个词里根本没有 /l/。结果是一个词后面拖一长串笔记，完全看不过来。
 *
 * 也不能只看 severity：那是**全局**的（他在 click 上错过 l/n），
 * 于是每个含 /n/ 的词都算"跟你有关"。
 *
 * 真正的判据**带方向**：他把 /l/ 念成 /n/，从不反过来。所以 l/n 那篇是含 /l/ 的词
 * 该看的。规则——**这篇教得了一处你真犯过的错，而那处错的目标音就在这个词里**。
 */
describe('笔记跟这个词有没有关系', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  async function setup() {
    const deps = testDeps();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'ng.md'), `---
id: n-vs-ng
title: 前后鼻音
triggers: [phoneme:n, phoneme:ŋ]
---
舌尖还是舌根。
`, 'utf8');
    deps.noteStore.load();
    return deps;
  }

  /** 词条得先存在——pronounce 不建词条 */
  async function mkEntry(deps: AppDeps, text: string) {
    await createApp(deps).request('/api/entries', {
      method: 'POST', body: JSON.stringify({ text }),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('他真犯过的错、目标音在这个词里 → 相关', async () => {
    const deps = await setup();
    // night 的 /n/ 反复念成 /ŋ/
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'ŋ aɪ t', phones: null, reason: null });
    for (let i = 0; i < 3; i++) {
      await createApp(deps).request('/api/pronounce?target=night&snr=35', { method: 'POST', body: wav });
    }
    await mkEntry(deps, 'night');
    const d = await (await createApp(deps).request('/api/entries/night')).json();
    const ng = d.notes.find((n: { id: string }) => n.id === 'n-vs-ng');
    expect(ng?.relevant, 'n→ŋ 是他真犯的错，night 里也有 /n/').toBe(true);
  });

  it('他犯的错目标音不在这个词里 → 不相关，收进折叠', async () => {
    const deps = await setup();
    // 他在 click 上把 /l/ 念成 /n/
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'k n ɪ k', phones: null, reason: null });
    for (let i = 0; i < 3; i++) {
      await createApp(deps).request('/api/pronounce?target=click&snr=35', { method: 'POST', body: wav });
    }
    // night 含 /n/，所以 l-vs-n 仍然会被 matchNotes 挂上——但它跟 night 无关：
    // 他错的是 /l/（目标音），而 night 里没有 /l/
    await mkEntry(deps, 'night');
    const d = await (await createApp(deps).request('/api/entries/night')).json();
    const ln = d.notes.find((n: { id: string }) => n.id === 'l-vs-n');
    expect(ln, 'l-vs-n 应该还在列表里（night 含 /n/）').toBeDefined();
    expect(ln.relevant, 'night 里没有 /l/，这篇不该摆在外面').toBe(false);
  });

  /**
   * ── 判据只算**这一个词**，不是"你在别处犯过 + 这个词里有那个音" ──
   *
   * 规则一句话：**这个词上没发错，那篇就不该出现在这个词上。**
   *
   * 实测过的原样：click 页面摆着「长短元音」，而他在 click 上从没错过 ɪ——
   * 那篇出现是因为他在 **thin** 上错过 ɪ→i，而 click 里正好有个 /ɪ/。
   * 更糟的是折叠那行写着「你还没在**这个词上**错过」，反过来就是在说
   * 外面那些他错过了——那句话当时是假的。
   *
   * 上面那条老测试挡不住这个：它验的是"目标音不在这个词里"，
   * 而这里目标音**在**这个词里，只是错发生在别的词上。
   */
  it('错发生在别的词上、这个词里恰好有那个音 → 仍然不该摆在外面', async () => {
    const deps = await setup();
    // 他在 night 上把 /n/ 念成 /ŋ/
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'ŋ aɪ t', phones: null, reason: null });
    for (let i = 0; i < 3; i++) {
      await createApp(deps).request('/api/pronounce?target=night&snr=35', { method: 'POST', body: wav });
    }
    // name 里也有 /n/，但他在 name 上一次都没录过、更没错过
    await mkEntry(deps, 'name');
    const d = await (await createApp(deps).request('/api/entries/name')).json();
    const ng = d.notes.find((n: { id: string }) => n.id === 'n-vs-ng');
    expect(ng, 'n-vs-ng 应该还在列表里（name 含 /n/）').toBeDefined();
    expect(ng.relevant, '他在 name 上没错过，这篇不该摆在外面').toBe(false);
    expect(ng.becauseOf, '没错过就不该有"因为你错过了什么"').toEqual([]);
  });

  it('摆在外面的要说得出是哪几处错把它拉出来的', async () => {
    const deps = await setup();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'ŋ aɪ t', phones: null, reason: null });
    for (let i = 0; i < 3; i++) {
      await createApp(deps).request('/api/pronounce?target=night&snr=35', { method: 'POST', body: wav });
    }
    await mkEntry(deps, 'night');
    const d = await (await createApp(deps).request('/api/entries/night')).json();
    const ng = d.notes.find((n: { id: string }) => n.id === 'n-vs-ng');
    expect(ng.relevant).toBe(true);
    // 界面上那行小字要说"你在这儿错过 n→ŋ"，而不是"因为这个词里有 /n/"
    expect(ng.becauseOf).toContain('n→ŋ');
  });

  it('漏音不决定相关性——它不指向任何一对音', async () => {
    // 实测：dopamine 里 `/n/ 没发出来` 2 次（多半是坏转写），按"漏音也算"的话
    // 会把 l-vs-n 拉到外面——而那个词里根本没有 /l/。
    // 替换点名了一对音，漏音只说"那个音没出现"，contrast 类的笔记教不了它。
    const deps = await setup();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'aɪ t', phones: null, reason: null });
    for (let i = 0; i < 4; i++) {
      await createApp(deps).request('/api/pronounce?target=night&snr=35', { method: 'POST', body: wav });
    }
    await mkEntry(deps, 'night');
    const d = await (await createApp(deps).request('/api/entries/night')).json();
    const ln = d.notes.find((n: { id: string }) => n.id === 'l-vs-n');
    expect(ln?.relevant, '一条漏音把 l-vs-n 拉到外面了').toBe(false);
  });

  it('讲这个词自己的笔记永远相关', async () => {
    const deps = await setup();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'w.md'), `---
id: about-night
title: night 这个词
triggers: []
words: [night]
---
讲 night 的。
`, 'utf8');
    deps.noteStore.load();
    await mkEntry(deps, 'night');
    const d = await (await createApp(deps).request('/api/entries/night')).json();
    expect(d.notes.find((n: { id: string }) => n.id === 'about-night')?.relevant).toBe(true);
  });

  it('全新的库：一篇都不相关——他还没错过任何东西', async () => {
    const deps = await setup();
    await mkEntry(deps, 'night');
    const d = await (await createApp(deps).request('/api/entries/night')).json();
    expect(d.notes.every((n: { relevant: boolean }) => !n.relevant)).toBe(true);
  });
});

describe('POST /api/pronounce（音素级听辨）', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);   // 边车被 mock 掉了，内容无所谓

  it('把边车的原始 IPA 归一化后跟目标音素逐个对齐', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'n aɪ t', phones: null, reason: null });
    const res = await createApp(deps).request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.heardIpa).toEqual(['n', 'aɪ', 't']);
    expect(body.align.map((o: { kind: string }) => o.kind)).toEqual(['match', 'match', 'match']);
  });

  /**
   * 空识别结果 = 这次**没录到声音**，不是"每个音都发错了"。
   *
   * 库里查出来的实况：4 次空识别造出了 15 条"没发出来"，而发音档案里
   * 「该补的笔记」排最前面的 /ɡ/ /æ/ /s/ /l/ 四项 100% 出自它们——
   * 工具在催人补一节它自己幻想出来的课。界面那头一直是对的（"再录一次"），
   * 错的是服务端：一边让界面说重录，一边把 4 条错误悄悄写进了档案。
   */
  it('一个音都没识别出来 → 拦掉，不记成"每个音都没发出来"', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: '', phones: null, reason: null });
    const res = await createApp(deps).request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/没录到/);
    // 关键：一条流水都不许留下，否则统计和「该补的笔记」照样被污染
    expect(overallStats(deps.db).attempts).toBe(0);
  });

  /**
   * 背景太吵时：结果照给（你需要这次的反馈），但**不沉淀**。
   * 实测过一段——同一个 light，早上两次都是干净的 /l aɪ t/，晚上连着五次被听成 /m ɛ t/。
   * 发音不会在几小时里变成这样，录音条件会。那批数据留下来会变成"你的习惯性短板"，
   * 而它记的其实是当时房间里的噪声。
   */
  it('信噪比太低 → 结果照给，但不进统计、不进复习队列', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'l aɪ t', phones: null, reason: null });
    const res = await createApp(deps).request('/api/pronounce?target=night&snr=12', { method: 'POST', body: wav });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 结果本身一点不打折——该报的错照报
    expect(body.align[0].kind).toBe('sub');
    // 但没落盘，而且**说明了原因**（界面要显示它）
    expect(body.recorded).toBe(false);
    expect(body.notRecordedReason).toMatch(/12dB/);
    expect(overallStats(deps.db).attempts).toBe(0);
    expect(deps.review.due(deps.today())).toHaveLength(0);
  });

  it('信噪比正常 → 照常落盘', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'l aɪ t', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=night&snr=35', { method: 'POST', body: wav })).json();
    expect(body.recorded).toBe(true);
    expect(body.notRecordedReason).toBeNull();
    expect(overallStats(deps.db).attempts).toBe(1);
  });

  it('前端没传信噪比 → 照记，不因为拿不到就静悄悄丢掉数据', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'l aɪ t', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=night', { method: 'POST', body: wav })).json();
    expect(body.recorded).toBe(true);
    expect(overallStats(deps.db).attempts).toBe(1);
  });

  /**
   * 评测结果挂的笔记，不能只认 phoneme:。
   *
   * 这里原来只由 `phoneme:${targetIpa}` / `phoneme:${heardIpa}` 组成，于是所有靠结构
   * 声明范围的笔记（cluster-onset / cluster-coda / clear-l / dark-l / flap-t）在
   * "你错了、该怎么改"这一块永远挂不上。最刺眼的是 kl-cluster：click 里加塞 /ə/
   * 是中文母语者第一号经典错，评测测得出来，而解释它的笔记不出现。
   * 词条页一直是对的（那里用 extractTags 的全集），只有这一块漏掉。
   */
  it('辅音连缀里加塞元音 → 要挂上讲连缀的笔记，不能只认 phoneme:', async () => {
    const deps = testDeps();
    // click /klɪk/ 念成 k-ə-l-ɪ-k：/k/ 和 /l/ 之间多了一个 ə
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'k ə l ɪ k', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=click&snr=35', { method: 'POST', body: wav })).json();
    expect(body.align.some((o: { kind: string }) => o.kind === 'ins')).toBe(true);
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('kl-cluster');
  });

  it('连缀里的音发成了别的音（不是加塞）→ 一样要挂上讲连缀的笔记', async () => {
    // 上一条走的是 ins 那条分支。sub / del 那条分支是**另一段代码**，
    // 只测 ins 的话「退回只认 phoneme:」这个改动照样活着（变异测试量出来的）。
    const deps = testDeps();
    // click /klɪk/ 的 l 发成了 n——出错的音本身是 kl 连缀的一员
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'k n ɪ k', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=click&snr=35', { method: 'POST', body: wav })).json();
    expect(body.align[1].kind).toBe('sub');
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('kl-cluster');
  });

  it('多出来的音之后，后面每个音的结构标签不许错位', async () => {
    // ins **不消耗**目标位置。消耗了的话它后面每个音读到的标签都往后串一格，
    // 而串位是静默的——出来的笔记只是"少了一篇"，没人会觉得不对。
    // **插入点必须离带标签的音远一点**：紧挨着的话，ins 那条分支自己就把两侧的标签
    // 推进去了，后面错不错位都看不出来（第一版用 `d ɛ s ə t`，变异照样活着）。
    // desk /dɛsk/ 念成「德-埃斯特」：ə 插在词首那个 d 后面，而出错的是词尾的 k。
    // k 在目标序列第 3 位、带着 cluster-coda:sk；错位一格就读到序列外，标签全丢。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'd ə ɛ s t', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=desk&snr=35', { method: 'POST', body: wav })).json();
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('coda-cluster');
  });

  /**
   * words: 范围的笔记讲的是"这个词自己的坑"。你正好掉进坑里的那一刻不告诉你，等于白写。
   * matchNotes 的第三个参数一度没传，这条守的就是它。
   */
  /**
   * 评测结果问的是「刚才那几处错，哪篇教得了」——**不是**「这个词涉及哪些讲解」。
   * 后者是词条页的问题，按音素出现匹配是对的（light 有 /l/ 就该看到 l/n 那篇）。
   *
   * 这里必须按**错误的那一对**来：替换是关于一对音的，一篇只讲到其中一个的笔记
   * 教不了这个混淆。实测 n→ŋ 被 l-vs-n 冒领了（那篇声明 phoneme:n），
   * 而它一个字都没提后鼻音。
   */
  it('替换错只挂两边都讲到的那篇，不挂只沾上一个音的', async () => {
    const deps = testDeps();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'ng.md'), `---
id: n-vs-ng
title: 前后鼻音
triggers: [phoneme:n, phoneme:ŋ]
---
舌尖还是舌根。
`, 'utf8');
    deps.noteStore.load();
    // night 的 /n/ 念成了 /ŋ/。testDeps 的 l-vs-n 只声明 phoneme:n，教不了这个
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'ŋ aɪ t', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=night&snr=35', { method: 'POST', body: wav })).json();
    const ids = body.notes.map((n: { id: string }) => n.id);
    expect(ids, 'n→ŋ 没挂上讲 n/ŋ 的那篇').toContain('n-vs-ng');
    expect(ids, 'l-vs-n 冒领了 n→ŋ——它一个字都没提后鼻音').not.toContain('l-vs-n');
  });

  it('不同处的错不许拼成一次命中', async () => {
    // 拍平成一个标签池的话，"某处错涉及 A、另一处错涉及 B"会让一篇讲 A+B 的笔记命中，
    // 而根本没有哪一处错同时涉及 A 和 B。dopamine 有 7 处错，池子大到什么都能沾上。
    const deps = testDeps();
    const dir = (deps.noteStore as unknown as { dir: string }).dir;
    writeFileSync(join(dir, 'cross.md'), `---
id: cross
title: 讲 l 和 t 的
triggers: [phoneme:l, phoneme:t]
---
两个不相干的音。
`, 'utf8');
    deps.noteStore.load();
    // night /n aɪ t/ → /l aɪ s/：第 1 处错涉及 l，第 3 处错涉及 t，但没有哪一处两者都涉及
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'l aɪ s', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=night&snr=35', { method: 'POST', body: wav })).json();
    expect(body.notes.map((n: { id: string }) => n.id), '跨两处错拼出了一次假命中')
      .not.toContain('cross');
  });

  it('念错了有 words 笔记的词 → 那篇笔记要出现在评测结果里', async () => {
    const deps = testDeps();
    // machine /məˈʃin/ 的 -ine 念成 /aɪn/——正是那篇笔记讲的坑
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'm ə ʃ aɪ n', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=machine&snr=35', { method: 'POST', body: wav })).json();
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('ine-spelling');
  });

  /**
   * 上面那条的另一半。**念对了就不该挂**——而这一半原来是漏的。
   *
   * 音素类的笔记不会犯这个错（它们走 explainerIds，那是从错误里推出来的），
   * 只有 words: 这一路是无条件的：沾上这个词就算，不看有没有错。
   * 库里 dopamine-detox 七十条证据里 7 条来自全对的录音，ine-spelling 也是 7 条。
   *
   * 而这份命中会原样存进 attempt_note，那张表是「这篇笔记讲的毛病你身上真有」的
   * 唯一证据来源，「录音里反复出现」这个标签就是数它算出来的——
   * 念对了也记一笔，等于拿"你练过这个词"冒充"你错过这个音"。
   */
  it('念对了有 words 笔记的词 → 既不挂那篇笔记，也不给它记一笔证据', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'm ə ʃ i n', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=machine&snr=35', { method: 'POST', body: wav })).json();
    expect(body.align.every((o: { kind: string }) => o.kind === 'match'), '前提：这次是全对').toBe(true);
    expect(body.notes.map((n: { id: string }) => n.id), '念对了还把这个词的笔记摆出来')
      .not.toContain('ine-spelling');
    expect(body.recorded, '前提：这次是真落盘了，证据表该有机会被写脏').toBe(true);
    expect(noteEvidence(deps.db).get('ine-spelling'), '全对的录音给笔记记了一笔证据')
      .toBeUndefined();
  });

  it('没念错的音，不该把它的结构笔记也拖出来', async () => {
    const deps = testDeps();
    // 全对：一篇笔记都不该挂
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'k l ɪ k', phones: null, reason: null });
    const body = await (await createApp(deps).request(
      '/api/pronounce?target=click&snr=35', { method: 'POST', body: wav })).json();
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
    expect(body.notes.map((n: { id: string }) => n.id)).not.toContain('kl-cluster');
  });

  it('发成了别的音 → sub，并挂上对应的笔记', async () => {
    const deps = testDeps();
    // 念 night 时发成了 light（边车如实吐 l，不往目标词上靠——这正是换掉 vosk 的理由）
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'l aɪ t', phones: null, reason: null });
    const body = await (await createApp(deps).request('/api/pronounce?target=night', { method: 'POST', body: wav })).json();
    expect(body.align[0]).toEqual({ kind: 'sub', targetIpa: 'n', heardIpa: 'l', sure: true });
    // testDeps 的 l-vs-n 笔记 trigger 是 phoneme:n，目标音那一侧就该命中它
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('l-vs-n');
  });

  it('漏音 → del（辅音连缀里丢掉一个辅音，只报替换的话什么都看不出来）', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'k ɪ k', phones: null, reason: null });
    const body = await (await createApp(deps).request('/api/pronounce?target=click', { method: 'POST', body: wav })).json();
    expect(body.align.filter((o: { kind: string }) => o.kind === 'del'))
      .toEqual([{ kind: 'del', targetIpa: 'l', sure: true }]);   // del 恒 sure："没发出来"谈不上把握程度
  });

  it('念对的 water 不报错（长音符、闪音 ɾ 都要被归一化掉）', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'w ɔː ɾ ɚ', phones: null, reason: null });
    const body = await (await createApp(deps).request('/api/pronounce?target=water', { method: 'POST', body: wav })).json();
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
  });

  it('重音变体 ə/ʌ 不算发音错误——模型不输出重音，这个维度没有判据', async () => {
    // about = AH0 B AW1 T → 目标音素 ə b aʊ t（AH0 被 parsePhones 改写成 ə）。
    // 模型对同一个音常常吐 ʌ（实测 love → `l ʌ v`），两者只差重音。不做归并的话，
    // 念得完全正确也会被报成"你把 ə 发成了 ʌ"——那是在断言输入里根本没有的信息。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'ʌ b aʊ t', phones: null, reason: null });
    const body = await (await createApp(deps).request('/api/pronounce?target=about', { method: 'POST', body: wav })).json();
    expect(body.align.map((o: { kind: string }) => o.kind)).toEqual(['match', 'match', 'match', 'match']);
  });

  it('笔记按【听到的音】也要能挂上，不只看目标音', async () => {
    // 目标 light（l aɪ t，不含 /n/），发成了 night（含 /n/）。testDeps 的 l-vs-n 笔记
    // trigger 是 phoneme:n——只有从**听到的**那一侧才能命中它。
    // 只看目标音的话，"你把 l 发成了 n"这种最典型的错误反而挂不上对应的笔记。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'n aɪ t', phones: null, reason: null });
    const body = await (await createApp(deps).request('/api/pronounce?target=light', { method: 'POST', body: wav })).json();
    expect(body.align[0]).toEqual({ kind: 'sub', targetIpa: 'l', heardIpa: 'n', sure: true });
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('l-vs-n');
  });

  it('归并只影响判错，不影响命名：dopamine 的 /ə/ 发错，报的名字必须是 /ə/ 不是 /ʌ/', async () => {
    // 对齐前两侧都做 ə→ʌ、ɚ→ɝ 归并（模型不输出重音，这个维度没有判据）。
    // 但**报错的名字**必须换回词典原名：以前无基准分支不改名，dopamine 的 /ə/ 发成 /æ/
    // 会被报成"把 /ʌ/ 发成了…"——音素条上明明显示 ə、phoneme:ə 的笔记挂不上、
    // 统计和档案记的也是 ʌ、部位尺讲的是 ʌ 的发音方式（schwa 的要点恰恰是"越轻越对"）。
    // 错的名字一路传到底，实测复现过。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'd oʊ p æ m i n',
      phones: ['d', 'oʊ', 'p', 'æ', 'm', 'i', 'n'].map((ipa) => ({ ipa, conf: 0.9 })),
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=dopamine', { method: 'POST', body: wav })).json();
    const sub = body.align.find((o: { kind: string }) => o.kind === 'sub');
    expect(sub).toMatchObject({ targetIpa: 'ə', heardIpa: 'æ', sure: true });
    // 统计（→ 发音档案的"该补的笔记"）也必须用词典名，否则 ə 的笔记永远反查不到
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.phonemes[0]).toMatchObject({ kind: 'sub', targetIpa: 'ə', heardIpa: 'æ' });
  });

  it('【听到侧】也必须换回未归并的名字：加塞的 /ə/ 不能报成 /ʌ/', async () => {
    // 上一版只换了目标侧，听到侧就地留着归并名。click 加塞 /ə/（使用者的招牌错误）实测：
    // 顶层 heardIpa 显示 ə，套印带同一屏写 ʌ；tag 变成 phoneme:ʌ，phoneme:ə 的笔记
    // 从听到侧永远挂不上；统计永久记成 ʌ。三条全中。
    const notesDir = mkdtempSync(join(tmpdir(), 'notes-schwa-'));
    writeFileSync(join(notesDir, 'schwa.md'), `---
id: schwa
title: schwa 越轻越对
triggers: [phoneme:ə]
severity: confirmed
---
越轻越对。
`, 'utf8');
    const noteStore = new NoteStore(notesDir);
    noteStore.load();
    const deps = { ...testDeps(), noteStore };
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'k ə l ɪ k',
      phones: ['k', 'ə', 'l', 'ɪ', 'k'].map((ipa) => ({ ipa, conf: 0.9 })),
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=click', { method: 'POST', body: wav })).json();
    const ins = body.align.find((o: { kind: string }) => o.kind === 'ins');
    expect(ins).toMatchObject({ heardIpa: 'ə', sure: true });
    // 顶层 heardIpa 和 op 上的名字必须是同一套，否则同屏两个名字
    expect(body.heardIpa).toContain('ə');
    // phoneme:ə 的笔记要能从听到侧挂上
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('schwa');
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.phonemes[0]).toMatchObject({ kind: 'ins', heardIpa: 'ə' });
  });

  it('念对的 ə/ɚ 位置：match 的黑蓝两版必须同字，不能画成重影', async () => {
    // 对齐在归并之后做，所以模型吐 ʌ、词典是 ə 时判成 match 是对的。
    // 但两侧各留自己的名字的话，套印带（match 语义是"两版完全重合，只见一个黑字"）
    // 会把**念对了**画成重影——about 念对实测 黑=ə 蓝=ʌ。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'ʌ b aʊ t',
      phones: ['ʌ', 'b', 'aʊ', 't'].map((ipa) => ({ ipa, conf: 0.9 })),
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=about', { method: 'POST', body: wav })).json();
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
    for (const o of body.align) expect(o.heardIpa).toBe(o.targetIpa);
    // 目标侧用词典名（ə），不是归并名（ʌ）
    expect(body.align[0].targetIpa).toBe('ə');
    // 模型的原始输出没有丢
    expect(body.heardIpa[0]).toBe('ʌ');
  });

  it('match 恒为 sure —— 置信度只用来判「报出来的错」可不可信', async () => {
    // 这一条被推翻过一次又推回来，完整理由写在 app.ts 算 sure 那一段。要点：
    // CONFIDENT 回答的是"这条断言出来的错可信吗"，而 match 没有断言任何错；
    // 低置信度不是"错"的证据。真让它成为一个状态，做出来的东西是坏的——
    // 那个「不确定」小注用的是仓库自己宣布"对比度 1.96:1、不配写字"的颜色，
    // 虚线框又只存在于 sub，而摘要/图例/复习评分全都照旧当它是对的。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'w ɔ t ɚ',
      phones: [{ ipa: 'w', conf: 0.96 }, { ipa: 'ɔ', conf: 0.2 }, { ipa: 't', conf: 0.9 }, { ipa: 'ɚ', conf: 0.74 }],
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=water', { method: 'POST', body: wav })).json();
    const low = body.align.find((o: { conf?: number }) => o.conf === 0.2);
    // 低置信度照样是 sure —— 拿不准不等于错
    expect(low).toMatchObject({ kind: 'match', sure: true });
    // 置信度本身没丢，仍然带在 op 上，将来要用得着（比如排查模型行为）
    expect(low.conf).toBe(0.2);
    // 不算错，统计干净
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.overall.clean).toBe(1);
    // 而 sub 的低置信度仍然会被判成拿不准 —— 范围只到「报出来的错」
    const deps2 = testDeps();
    deps2.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'w ɔ t ɑ',
      phones: [{ ipa: 'w', conf: 0.96 }, { ipa: 'ɔ', conf: 0.9 }, { ipa: 't', conf: 0.9 }, { ipa: 'ɑ', conf: 0.2 }],
      reason: null,
    });
    const body2 = await (await createApp(deps2).request('/api/pronounce?target=water', { method: 'POST', body: wav })).json();
    expect(body2.align.find((o: { kind: string }) => o.kind === 'sub')).toMatchObject({ sure: false });
  });

  it('置信度恰好等于门槛算确定的（钉住 >= 而不是 >）', async () => {
    // 这条边界原来由 web/src/lib/align.test.ts（当时叫 noise.test.ts） 的一个用例守着，门槛收归服务端时
    // 那个用例被删了，而替换的注释谎称"门槛语义已在 app.test.ts 钉住"——其实没有：
    // 那时这个文件只用到 0.31 和 0.9。把 >= 改成 > 全套测试照样绿，
    // 而恰好落在门槛上的判定会从"确凿的错"翻成"拿不准"：不标红、不挂笔记、不进统计，
    // 对 ins 还会被当成杂音整条丢掉。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'l aɪ t',
      // **用 CONFIDENT 而不是写死 0.5。** 写死的话，这条用例只在常量恰好等于 0.5 时
      // 才真的钉住边界——而 espeak.ts 的 JSDoc 就在叫人按实测去重调它。
      // 实验过：CONFIDENT 改 0.4 再把 >= 改成 >，写死 0.5 的版本 93 个用例全绿。
      phones: [{ ipa: 'l', conf: CONFIDENT }, { ipa: 'aɪ', conf: 0.9 }, { ipa: 't', conf: 0.9 }],
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=night', { method: 'POST', body: wav })).json();
    const sub = body.align.find((o: { kind: string }) => o.kind === 'sub');
    expect(sub).toMatchObject({ targetIpa: 'n', heardIpa: 'l', conf: CONFIDENT, sure: true });
    expect((await (await app.request('/api/stats')).json()).phonemes).toHaveLength(1);
  });

  it('低置信度的"错"不算错——不标红、不挂笔记、不进统计', async () => {
    // 实测：water 的 ɑː 置信度只有 0.31、cat 的 eː 只有 0.33，都是模型自己拿不准。
    // 把这种当成确凿的发音错误，发音档案里会堆满根本不存在的问题，还会生成一堆
    // 假的"该补的笔记"——比不统计更糟。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'w ɑː ɾ ɚ',
      phones: [{ ipa: 'w', conf: 0.96 }, { ipa: 'ɑː', conf: 0.31 }, { ipa: 'ɾ', conf: 0.8 }, { ipa: 'ɚ', conf: 0.74 }],
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=water', { method: 'POST', body: wav })).json();
    // 对齐结果里那处 sub 仍然如实给出（前端会标成"模型不太确定"），但 conf 带出来了
    const sub = body.align.find((o: { kind: string }) => o.kind === 'sub');
    // sure 由服务端算好带在 op 上——0.5 门槛只在 espeak.ts 有一份，前端一律用 op.sure
    expect(sub).toMatchObject({ targetIpa: 'ɔ', heardIpa: 'ɑ', conf: 0.31, sure: false });
    // 统计里不该出现它
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.phonemes).toEqual([]);
    // **但这次不算全对。**「没有确凿的错」不等于「对」——模型在那一处听到的是
    // 别的音（ɔ→ɑ），只是没把握。原来这里断言 clean===1，那正是那个 bug：
    // 实测 47 次评测里 6 次判全对，5 次是这么来的
    // （thin [θ ɪ n] → [f ɛ n] 被记成了每个音都对）。
    // 两个问题不是一个：ops 回答"哪些错该进统计"，clean 回答"这次到底对没对"。
    expect(stats.overall.clean).toBe(0);
  });

  it('拿不准的**多余音**不影响全对——那几乎只能是杂音', async () => {
    // isNoise 的分工：多余音的不确定是"那儿到底有没有音"，
    // 跟"那个音是什么"的不确定不是一回事。一次好录音不该因为一声气流被判成没测准。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'n aɪ ə t',
      phones: [
        { ipa: 'n', conf: 0.96 }, { ipa: 'aɪ', conf: 0.9 },
        { ipa: 'ə', conf: 0.2 },        // 拿不准的多余音 = 杂音
        { ipa: 't', conf: 0.95 },
      ],
      reason: null,
    });
    const app = createApp(deps);
    await app.request('/api/pronounce?target=night&snr=35', { method: 'POST', body: wav });
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.overall.clean, '一声杂音把好录音判成了没测准').toBe(1);
  });

  it('高置信度的错照常算数', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'l aɪ t',
      phones: [{ ipa: 'l', conf: 0.96 }, { ipa: 'aɪ', conf: 0.87 }, { ipa: 't', conf: 0.97 }],
      reason: null,
    });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=night', { method: 'POST', body: wav })).json();
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('l-vs-n');
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.phonemes).toHaveLength(1);
    expect(stats.phonemes[0]).toMatchObject({ kind: 'sub', targetIpa: 'n', heardIpa: 'l', count: 1 });
  });

  it('漏音（del）不受置信度影响——"没发出来"谈不上把握程度', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'k ɪ k',
      phones: [{ ipa: 'k', conf: 0.99 }, { ipa: 'ɪ', conf: 0.9 }, { ipa: 'k', conf: 0.95 }],
      reason: null,
    });
    const app = createApp(deps);
    await app.request('/api/pronounce?target=click', { method: 'POST', body: wav });
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.phonemes.map((p: { kind: string }) => p.kind)).toContain('del');
  });

  it('边车没给置信度（旧版）→ 退化成每个音都当确定的，不是全判成不确定', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'l aɪ t', phones: null, reason: null });
    const app = createApp(deps);
    const body = await (await app.request('/api/pronounce?target=night', { method: 'POST', body: wav })).json();
    expect(body.notes.map((n: { id: string }) => n.id)).toContain('l-vs-n');
    expect((await (await app.request('/api/stats')).json()).phonemes).toHaveLength(1);
  });

  it('边车没起 → 503 且带 reachable:false，前端据此降级而不是当成发音错误', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: false, ipa: null, phones: null, reason: '音素识别服务没启动' });
    const res = await createApp(deps).request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: '音素识别服务没启动', reachable: false });
  });

  it('短语按词拆开查词典，音素首尾相接后整串对齐', async () => {
    // black cat = B L AE1 K + K AE1 T。模型对短语是连着吐的（spike 实测
    // black-cat → `b l æ k k æ t`），所以对齐也按一整串来。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: 'b l æ k k æ t', phones: null, reason: null });
    const res = await createApp(deps).request('/api/pronounce?target=black%20cat', { method: 'POST', body: wav });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.targetIpa).toEqual(['b', 'l', 'æ', 'k', 'k', 'æ', 't']);
    expect(body.words).toEqual([
      { word: 'black', ipa: ['b', 'l', 'æ', 'k'] },
      { word: 'cat', ipa: ['k', 'æ', 't'] },
    ]);
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
  });

  it('短语里有一个词查不到 → 400 并点名是哪个词', async () => {
    const res = await createApp(testDeps()).request('/api/pronounce?target=black%20zzxxqq', { method: 'POST', body: wav });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('zzxxqq');
    // 不能把整个短语原样报成查不到——那样用户不知道该改哪个词
    expect(error).not.toContain('black zzxxqq');
  });

  it('缺 target / 空音频 / CMUdict 查不到 → 400，绝不 500', async () => {
    const app = createApp(testDeps());
    expect((await app.request('/api/pronounce', { method: 'POST', body: wav })).status).toBe(400);
    expect((await app.request('/api/pronounce?target=night', { method: 'POST', body: new Uint8Array() })).status).toBe(400);
    expect((await app.request('/api/pronounce?target=zzxxqq', { method: 'POST', body: wav })).status).toBe(400);
  });

  // ── 两个字段是两件事，都要断言 ──
  //
  // ok = 边车这一刻起没起来；uv = 这台机器上有没有 uv。**没有 uv 的话边车永远起不来**，
  // 界面据此立刻给装法而不是让人干等（Recorder 里 sidecar === 'no-uv' 那一档）。
  //
  // 这条测试原来只写 `toEqual({ ok: true })`，而它能过**恰恰是因为 testDeps 漏了
  // hasUv**：undefined 被 JSON.stringify 丢掉，响应里根本没有 uv 这个键。
  // 于是 uv 这个字段从来没被任何测试碰过。补上 hasUv 之后这条当场红了。
  it('GET /api/pronounce/health 两个字段都透传：边车起没起、有没有 uv', async () => {
    const up = testDeps(); up.checkPhonemeAsr = vi.fn().mockResolvedValue(true);
    expect(await (await createApp(up).request('/api/pronounce/health')).json()).toEqual({ ok: true, uv: true });

    const down = testDeps(); down.checkPhonemeAsr = vi.fn().mockResolvedValue(false);
    expect(await (await createApp(down).request('/api/pronounce/health')).json()).toEqual({ ok: false, uv: true });

    // 没装 uv：边车永远起不来，这一档界面要直接给装法
    const noUv = testDeps(); noUv.hasUv = false; noUv.checkPhonemeAsr = vi.fn().mockResolvedValue(false);
    expect(await (await createApp(noUv).request('/api/pronounce/health')).json()).toEqual({ ok: false, uv: false });
  });
});

describe('复习队列由证据驱动，不由「查过」驱动', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  it('只是录入词条，不进复习队列', async () => {
    // 这是整条规则的根：「查过这个词」和「要练这个词」是两回事。
    // 原来每 POST 一个词就自动建一张卡，于是灌几十个词进去队列就废了。
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'night');
    expect(deps.review.due('2099-01-01')).toEqual([]);
  });

  it('录音发错了才进队列', async () => {
    const deps = testDeps();
    // 得先有词条：复习卡只建在真实存在的词条上（建在裸词上的卡永远打不开）
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'l aɪ t',
      phones: [{ ipa: 'l', conf: .96 }, { ipa: 'aɪ', conf: .9 }, { ipa: 't', conf: .95 }],
      reason: null,
    });
    const app = createApp(deps);
    await addEntry(app, 'night');
    await app.request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(deps.review.due('2099-01-01').map((c) => c.text)).toEqual(['night']);
  });

  it('念对了不进队列——没有证据说明你需要练它', async () => {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'n aɪ t',
      phones: [{ ipa: 'n', conf: 1 }, { ipa: 'aɪ', conf: .9 }, { ipa: 't', conf: .95 }],
      reason: null,
    });
    const app = createApp(deps);
    await app.request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(deps.review.due('2099-01-01')).toEqual([]);
  });

  it('模型拿不准的"错"也不进队列', async () => {
    // 低置信度的误报一旦让词条进了复习队列，队列会被假问题灌满——
    // 跟统计不收低置信度是同一个理由。
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'l aɪ t',
      phones: [{ ipa: 'l', conf: .2 }, { ipa: 'aɪ', conf: .9 }, { ipa: 't', conf: .95 }],
      reason: null,
    });
    const app = createApp(deps);
    await app.request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(deps.review.due('2099-01-01')).toEqual([]);
  });
});

describe('音素 vs 词：两种笔记范围不许混', () => {
  /**
   * 症状：点音素 aɪ 弹出的是「dopamine 的词尾 /miːn/」，跟这个音毫无关系。
   * 根因是 Note 当时只有 triggers，一篇讲词的笔记想让自己出现只能声明音素 trigger，
   * 于是 dopamine 那篇写了 phoneme:aɪ —— 任何含 aɪ 的词都会命中它。
   * 更荒谬的是 aɪ 在那篇里的身份恰恰是**念错了才会得到的音**。
   */
  function withNotes(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'notes-scope-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
    const noteStore = new NoteStore(dir);
    noteStore.load();
    return { ...testDeps(), noteStore };
  }

  const WORD_NOTE = `---
id: dopa
title: Dopamine —— 词尾读 meen 不读 mine
words: [dopamine]
---
词尾是 meen。
`;
  const PHONEME_NOTE = `---
id: ai
title: aɪ 双元音
triggers: [phoneme:aɪ]
---
从啊滑到衣。
`;

  it('讲词的笔记只出现在它自己那个词上，不因为别的词含同一个音而冒出来', async () => {
    const app = createApp(withNotes({ 'w.md': WORD_NOTE }));
    // dopamine 自己：该出现
    const dopa = await (await addEntry(app, 'dopamine')).json();
    expect(dopa.notes.map((n: { id: string }) => n.id)).toContain('dopa');
    // night 也含 aɪ，但跟 dopamine 无关：**不该**出现
    const night = await (await addEntry(app, 'night')).json();
    expect(night.notes.map((n: { id: string }) => n.id)).not.toContain('dopa');
  });

  it('讲音的笔记照常按音命中——两种范围各行其道', async () => {
    const app = createApp(withNotes({ 'w.md': WORD_NOTE, 'p.md': PHONEME_NOTE }));
    const night = await (await addEntry(app, 'night')).json();
    const ids = night.notes.map((n: { id: string }) => n.id);
    expect(ids).toContain('ai');      // 含 aɪ → 讲 aɪ 的笔记该来
    expect(ids).not.toContain('dopa'); // 但讲 dopamine 的不该来
  });

  it('音素文档只列讲这个音的笔记，不列讲词的', async () => {
    const app = createApp(withNotes({ 'w.md': WORD_NOTE, 'p.md': PHONEME_NOTE }));
    await addEntry(app, 'dopamine');
    await addEntry(app, 'night');
    const d = await (await app.request(`/api/phonemes/${encodeURIComponent('aɪ')}`)).json();
    expect(d.notes.map((n: { id: string }) => n.id)).toEqual(['ai']);
    // 例词按"库里含这个音的词"给——这是使用者要的"针对这个音素的示例"
    expect(d.examples.map((e: { text: string }) => e.text)).toContain('night');
    expect(d.phone.howTo).toBeTruthy();
  });

  it('两者都空的笔记会告警——那种笔记永远匹配不上任何词条', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withNotes({
      'orphan.md': `---
id: orphan
title: 孤儿
---
没人看得见。
`,
    });
    expect(warn.mock.calls.flat().join(' ')).toContain('永远匹配不上');
    warn.mockRestore();
  });

  it('音素表里不存在的符号 → 404，不是空页面', async () => {
    const res = await createApp(testDeps()).request('/api/phonemes/zz');
    expect(res.status).toBe(404);
  });
});

describe('比对基准：优先跟参考录音比，不跟词典比', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  /**
   * 造一个"有真人录音"的词条。fetchMw 返回文件名，同时把那个文件真写到 audioDir——
   * referenceBaseline 会去读它。
   */
  // 参数顺序对应**路由里实际的调用顺序**：先转写你的录音（asr），再转写参考录音
  // （referenceBaseline）。反过来写的话，两个 mock 会互换，测出来的东西跟以为的不是一回事。
  // word 默认 book；只有需要词典里带 /ə/ 的词时才换（book 没有 schwa）
  async function withReference(yourIpa: string, refIpaFromModel: string, word = 'book') {
    const deps = testDeps();
    deps.fetchMw = vi.fn().mockResolvedValue('book-mw.mp3');
    const app = createApp(deps);
    await addEntry(app, word);
    writeFileSync(join(deps.audioDir, 'book-mw.mp3'), 'fake', 'utf8');

    // 第一次调用是转写参考录音，第二次是转写你的录音
    deps.recognizePhonemes = vi.fn()
      .mockResolvedValueOnce({
        reachable: true, ipa: yourIpa,
        phones: yourIpa.split(' ').map((ipa) => ({ ipa, conf: 0.95 })),
        reason: null,
      })
      .mockResolvedValue({ reachable: true, ipa: refIpaFromModel, phones: null, reason: null });
    return { deps, app };
  }

  it('模型对参考录音的系统性偏置不再被报成发音错', async () => {
    // 实测：book 的词典音标是 /b ʊ k/，但模型对真人录音转出的是 /b æ k/——
    // 那是模型在元音上的偏置，不是发音错。跟词典比会报一处 sub（然后靠置信度门槛掩盖，
    // 于是三分之一的元音判断被整块扔掉）。跟参考转写比，偏置两边抵消。
    const { app } = await withReference('b æ k', 'b æ k');
    const body = await (await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav })).json();
    expect(body.comparedWith).toBe('reference');
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
  });

  it('真发错了照样报出来，而且用【词典的】音标命名', () => {
    // 这一条守的是命名：基准是 /b æ k/，但界面必须说"该发 /ʊ/"——
    // 说"该发 /æ/"是胡说，book 的目标本来就是 /ʊ/。
    return withReference('b æ t', 'b æ k').then(async ({ app }) => {
      const body = await (await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav })).json();
      const sub = body.align.find((o: { kind: string }) => o.kind === 'sub');
      expect(sub).toMatchObject({ targetIpa: 'k', heardIpa: 't' });
      // 第二个位置用的是词典的 ʊ，不是基准的 æ
      expect(body.align[1]).toMatchObject({ kind: 'match', targetIpa: 'ʊ' });
    });
  });

  it('念得跟词典一字不差、却不等于参考转写 → 不许报成错，更不许建复习卡', async () => {
    // 这一条守的是「念对了反而被记成错」这个最坏的误报。
    //
    // 怎么发生的：对齐用的是参考转写（b æ k，模型的元音偏置），目标名换成的是词典音标
    // （b ʊ k）。用户念出 b ʊ k——跟词典一字不差——相对参考却在第 2 位不同，
    // 于是判成 sub，改名后两边又变回同一个符号：sub 目标=ʊ 听到=ʊ。
    // 实测过：界面说"你把 /ʊ/ 发成了 /ʊ/"、进统计、**还建了复习卡**。
    //
    // 库里已经攒了 8 条这种假错：把 /i/ 发成了 /i/（7 次，一度是「最常犯的错」榜首）、
    // 把 /ʌ/ 发成了 /ʌ/（1 次）。
    const { deps, app } = await withReference('b ʊ k', 'b æ k');
    const body = await (await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav })).json();
    expect(body.comparedWith).toBe('reference');
    // 目标==听到的那一步必须是 match，不是 sub
    expect(body.align.every((o: { kind: string }) => o.kind === 'match')).toBe(true);
    for (const o of body.align) expect(o.heardIpa).toBe(o.targetIpa);
    // 不进统计
    expect((await (await app.request('/api/stats')).json()).phonemes).toEqual([]);
    // 也不该建复习卡——复习队列只收有证据的词，这次没有证据
    expect(deps.review.dueAll()).toEqual([]);
  });

  it('只差重音的那一对（ə/ʌ）也不算错——那个维度这个工具明说测不了', async () => {
    // 上一条比的是字面相等，够不到这一格：基准是 ɔ、用户发出 ʌ、词典是 ə，
    // 三个符号两两不等，于是报出一句「你把 /ə/ 发成了 /ʌ/」——
    // **沿着一个它自己声明不评判的维度报错**（模型不输出重音，见 collapseStress）。
    // 实测 attempt 244 就是这么来的（那时基准还没被纠正）。
    // 三个符号必须**两两不等**，否则上一条的字面比较就先接住了：
    // 词典 ə、基准 ɔ、用户实际发出 ʌ（模型确实会吐 ʌ，attempt 251/252/256 都是）
    const { deps, app } = await withReference('ʌ b aʊ t', 'ɔ b aʊ t', 'about');
    const body = await (await app.request('/api/pronounce?target=about&entry=about', { method: 'POST', body: wav })).json();
    expect(body.comparedWith, '没走到参考基准这一路，这条用例就白设了').toBe('reference');
    const bad = body.align.filter((o: { kind: string }) => o.kind !== 'match');
    expect(bad, '沿着重音维度报了错').toEqual([]);
    expect((await (await app.request('/api/stats')).json()).phonemes).toEqual([]);
    expect(deps.review.dueAll()).toEqual([]);
  });

  it('反过来也一样：词典是 /ʌ/、模型吐 /ə/', async () => {
    // 两侧都要归并，不能只归并目标那一侧。cup 的词典音标是 /k ʌ p/（重读的 AH1），
    // 而模型对同一段音吐 ə 是常事——只收拾目标侧的话，这一格照样会报出
    // 「把 /ʌ/ 发成了 /ə/」。
    const { app } = await withReference('k ə p', 'k ɔ p', 'cup');
    const body = await (await app.request('/api/pronounce?target=cup&entry=cup', { method: 'POST', body: wav })).json();
    expect(body.comparedWith).toBe('reference');
    expect(body.align.filter((o: { kind: string }) => o.kind !== 'match')).toEqual([]);
  });

  it('参考转写跟词典音素数不一致时退回词典，不张冠李戴', async () => {
    // 位置对不上就没法用词典音标命名。实测 30/30 都等长，走到这一支说明反常，宁可退回。
    const { app } = await withReference('b ʊ k', 'b æ');
    const body = await (await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav })).json();
    expect(body.comparedWith).toBe('dictionary');
  });

  it('只有 TTS 合成音时退回词典——合成音不能当标尺', async () => {
    // 实测 cat 的 TTS 被模型转成 /k eː t/，错得比词典还远。拿它当标准会把正确发音判成错。
    const deps = testDeps();
    deps.fetchMw = vi.fn().mockResolvedValue(null);      // MW 没拿到 → 落到 TTS
    deps.synthTts = vi.fn().mockResolvedValue('book-tts.mp3');
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'b ʊ k',
      phones: [{ ipa: 'b', conf: .9 }, { ipa: 'ʊ', conf: .9 }, { ipa: 'k', conf: .9 }],
      reason: null,
    });
    const app = createApp(deps);
    await addEntry(app, 'book');
    const body = await (await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav })).json();
    expect(body.comparedWith).toBe('dictionary');
  });

  it('参考转写只算一次，之后走缓存', async () => {
    const { deps, app } = await withReference('b æ k', 'b æ k');
    await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav });
    const afterFirst = (deps.recognizePhonemes as ReturnType<typeof vi.fn>).mock.calls.length;
    await app.request('/api/pronounce?target=book&entry=book', { method: 'POST', body: wav });
    const afterSecond = (deps.recognizePhonemes as ReturnType<typeof vi.fn>).mock.calls.length;
    // 第二次只该转写你的录音，不再转参考录音
    expect(afterSecond - afterFirst).toBe(1);
    expect(afterFirst).toBe(2);
  });
});

describe('短语里的单词：流水和复习卡记在词条上，不记在裸词上', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  function wrongDeps() {
    const deps = testDeps();
    deps.recognizePhonemes = vi.fn().mockResolvedValue({
      reachable: true, ipa: 'l aɪ t',
      phones: [{ ipa: 'l', conf: .96 }, { ipa: 'aɪ', conf: .9 }, { ipa: 't', conf: .95 }],
      reason: null,
    });
    return deps;
  }

  it('带 entry 参数时，复习卡建在词条上', async () => {
    // 短语页是逐词录的："dark night" 里单独录 night。建在裸词上的话：
    // 统计页的例词链接指向 404 的词条页；复习队列多出一张永远打不开的卡，
    // 每天出现、每天被跳过，而 advance() 只动本地队列不动文件——永远清不掉。
    const deps = wrongDeps();
    const app = createApp(deps);
    await addEntry(app, 'dark night');
    await app.request('/api/pronounce?target=night&entry=dark%20night', { method: 'POST', body: wav });

    expect(deps.review.dueAll()).toEqual(['dark night']);
    const stats = await (await app.request('/api/stats')).json();
    expect(stats.phonemes[0].words).toEqual(['dark night']);
  });

  it('词条不存在时不建卡——建了也是一张永远打不开的卡', async () => {
    const deps = wrongDeps();
    const app = createApp(deps);
    // 没有任何词条，直接对 night 录音
    await app.request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(deps.review.dueAll()).toEqual([]);
  });

  it('不带 entry 时退回 target（单词页的正常情形）', async () => {
    const deps = wrongDeps();
    const app = createApp(deps);
    await addEntry(app, 'night');
    await app.request('/api/pronounce?target=night', { method: 'POST', body: wav });
    expect(deps.review.dueAll()).toEqual(['night']);
  });
});

describe('手动收藏', () => {
  it('标星把词加进队列，取消标星又拿出来（从没错过的词）', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'night');

    const on = await app.request('/api/review/night/star', { method: 'PUT' });
    expect(on.status).toBe(200);
    expect(deps.review.due('2099-01-01').map((c) => c.text)).toEqual(['night']);
    expect(deps.review.cardOf('night')?.starred).toBe(true);

    const off = await app.request('/api/review/night/star', { method: 'DELETE' });
    expect(off.status).toBe(200);
    // 从没被判错过，取消收藏后留在队列里没有任何理由——直接出列
    expect(deps.review.due('2099-01-01')).toEqual([]);
  });

  it('对已经在队列里的词标星，不重置它爬到的级别', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await addEntry(app, 'night');
    deps.review.addCard('night', '2026-01-01');
    // 连对两次才升一档
    deps.review.grade('night', 'remembered', '2026-01-02');
    deps.review.grade('night', 'remembered', '2026-01-03');
    const before = deps.review.cardOf('night')!.rung;
    expect(before).toBe(1);

    await app.request('/api/review/night/star', { method: 'PUT' });
    expect(deps.review.cardOf('night')).toMatchObject({ rung: before, starred: true });
  });

  it('词条不存在时标星返回 404，不凭空造一张卡', async () => {
    const app = createApp(testDeps());
    expect((await app.request('/api/review/zzxxqq/star', { method: 'PUT' })).status).toBe(404);
  });
});

describe('毕业出列', () => {
  it('爬到顶级又连对两次 → 出列，别一周一次地永远回来', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    deps.review.addCard('night', '2026-01-01');
    // 阶梯 [1,2,3,5,7] 共 5 级，**每级要连对两次**：8 次答对爬到顶（rung 4），
    // 再连对两次才毕业——所以第 9 次只是攒上连胜，第 10 次才出列。
    for (let i = 0; i < 8; i++) deps.review.grade('night', 'remembered', day(i));
    expect(deps.review.cardOf('night')).toMatchObject({ rung: 4 });
    expect(deps.review.grade('night', 'remembered', '2026-02-01'), '第 9 次就毕业了，连胜没数').not.toBeNull();
    expect(deps.review.grade('night', 'remembered', '2026-02-02')).toBeNull();
    expect(deps.review.cardOf('night')).toBeUndefined();

    // 再 grade 一次应当是 404（卡已经不在了），而不是 500
    const res = await app.request('/api/review/night', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade: 'remembered' }),
    });
    expect(res.status).toBe(404);
  });

  it('收藏的卡片不毕业——那是你自己要留的', async () => {
    const deps = testDeps();
    deps.review.addCard('night', '2026-01-01', true);
    // 答对次数远超毕业线。收藏的卡片顶到 rung 4 就停在那儿，不出列。
    for (let i = 0; i < 14; i++) deps.review.grade('night', 'remembered', day(i));
    expect(deps.review.cardOf('night')).toMatchObject({ starred: true, rung: 4 });
  });

  it('答错的照常打回 rung 0，不会因为在顶级就出列', async () => {
    const deps = testDeps();
    deps.review.addCard('night', '2026-01-01');
    for (let i = 0; i < 8; i++) deps.review.grade('night', 'remembered', day(i));
    expect(deps.review.cardOf('night')).toMatchObject({ rung: 4 });
    deps.review.grade('night', 'forgot', '2026-02-01');
    expect(deps.review.cardOf('night')).toMatchObject({ rung: 0 });
  });
});

/**
 * ── 「这处错谁来讲」：目标音是门票，错法也要覆盖到，但错法可以走 contrasts ──
 *
 * 这一节是两个相反的坏法之间那条窄缝，两边都栽过：
 *
 * **往松了走**：只要沾上一个音素就算命中 → `/n/→/ŋ/` 被 l-vs-n 认领，
 * 而那篇一个字都没提后鼻音，真问题从「该补的笔记」里消失。
 *
 * **往紧了走**：改成"目标音和错法都必须在 triggers 里" → `θ→s` 时 th 那篇挂不上，
 * 因为 AGENTS.md 明写着「念错了才会得到的那个音，不该当 trigger」，所以它没有
 * 也不该有 `phoneme:s`。实测：报出 θ→s，notes 返回 []——**一篇专门讲这个错的笔记，
 * 在这个错发生时不出现**——报了错，下面却没有任何一篇笔记说这个错是怎么回事。
 *
 * 缝在这儿：错法写进 `contrasts:`，它只回答"这处错谁来讲"，
 * **不影响这篇出现在哪些词条页**——所以 th 那篇不会因此弹在每个含 /s/ 的词上。
 */
describe('报错时该配哪几篇讲解', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  /** 只装一篇 th 笔记的 deps。front 是 frontmatter 的若干行 */
  function withNote(...front: string[]) {
    const notesDir = mkdtempSync(join(tmpdir(), 'notes-th-'));
    writeFileSync(join(notesDir, 'th.md'), `---
id: th-vs-s
title: 齿间擦音
${front.join('\n')}
---
舌尖轻轻探出上下门齿之间。
`, 'utf8');
    const noteStore = new NoteStore(notesDir);
    noteStore.load();
    return { ...testDeps(), noteStore };
  }

  async function noteIds(deps: AppDeps, word: string, heard: string) {
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: heard, phones: null, reason: null });
    const r = await createApp(deps).request(`/api/pronounce?target=${word}&snr=35`, { method: 'POST', body: wav });
    const d = await r.json();
    return (d.notes as Array<{ id: string }>).map((n) => n.id);
  }

  const TH = 'triggers: [phoneme:θ, phoneme:ð]';
  const CONTRASTS = 'contrasts: [s, f]';

  it('θ→s：声明了 contrasts 就挂得上', async () => {
    const deps = withNote(TH, CONTRASTS);
    expect(await noteIds(deps, 'thin', 's ɪ n'), 'θ→s 报出来了，讲 θ 的笔记却没跟上').toContain('th-vs-s');
  });

  it('θ→s：没声明 contrasts 就挂不上——错法必须被覆盖到', async () => {
    // 这一条守的是别往松了走。松了的话 l-vs-n 会去认领 n→ŋ。
    const deps = withNote(TH);
    expect(await noteIds(deps, 'thin', 's ɪ n')).not.toContain('th-vs-s');
  });

  it('contrasts 不能当门票：反方向的错（s→θ）挂不上讲 θ 的笔记', async () => {
    // contrasts 说的是"念错了会变成什么"，不是"这篇也是关于那个音的课"。
    // 目标音是 /s/ 却发出了 /θ/，那是**用力过猛**，跟"θ 发不出来"是两个毛病；
    // 而这篇笔记从头到尾在教怎么把 θ 发出来。
    // 门票只能来自 triggers，否则 contrasts 就悄悄变成了第二份 triggers——
    // 而它恰恰是为了**不**影响匹配范围才单开的字段。
    const deps = withNote(TH, CONTRASTS);
    expect(await noteIds(deps, 'six', 'θ ɪ k s')).not.toContain('th-vs-s');
  });

  it('contrasts 不影响这篇出现在哪些词上', async () => {
    // 关键：contrasts 写了 s，但 six 的词条页不该因此弹出讲 θ 的笔记。
    // 这正是当初不许把错法写进 triggers 的理由。
    const deps = withNote(TH, CONTRASTS);
    await createApp(deps).request('/api/entries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'six' }),
    });
    const d = await (await createApp(deps).request('/api/entries/six')).json();
    expect((d.notes as Array<{ id: string }>).map((n) => n.id)).not.toContain('th-vs-s');
  });

  it('l-vs-n 认领不了 n→ŋ——它一个字没提后鼻音', async () => {
    const deps = testDeps();   // fixture 里的 l-vs-n 声明 phoneme:l 和 phoneme:n
    expect(await noteIds(deps, 'thin', 'θ ɪ ŋ')).not.toContain('l-vs-n');
  });

  it('双向混淆两边都在 triggers 里，不用 contrasts', async () => {
    // l/n 这类两边都是真实目标音的对立，本来就该两个都写进 triggers
    const deps = testDeps();
    expect(await noteIds(deps, 'night', 'l aɪ t')).toContain('l-vs-n');
  });
});

/**
 * ── 搬家：导出 / 导入 ──
 *
 * 换台电脑时，`notes/` 跟着 git 走，但**查过哪些词、每一次录音的判定、复习排到第几档**
 * 只在本机——丢了就没有，那是几十次录音攒出来的，不是重下一遍音频能补回来的。
 *
 * 这一节守的核心是**导入只加不减**：它的典型场景是"两台机器合起来"，
 * 而本机的记录是刚练出来的。一个会覆盖的导入按钮，按错一次就没了。
 */
describe('导出 / 导入备份', () => {
  const wav = new Uint8Array([1, 2, 3, 4]);

  async function seed(deps: AppDeps, word: string, heard: string) {
    deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: heard, phones: null, reason: null });
    await createApp(deps).request(`/api/pronounce?target=${word}&snr=35`, { method: 'POST', body: wav });
  }

  it('导出带上词条和每一次录音的判定', async () => {
    const deps = testDeps();
    await addEntry(createApp(deps), 'thin');
    await seed(deps, 'thin', 's ɪ n');
    const b = await (await createApp(deps).request('/api/backup')).json();
    expect(b.version).toBe(1);
    expect(b.entries.map((e: { text: string }) => e.text)).toContain('thin');
    expect(b.attempts).toHaveLength(1);
    expect(b.attempts[0].errors.length, '错误明细没带上，导回去统计就空了').toBeGreaterThan(0);
  });

  it('**不**带音频和参考转写——那些重查一次词典就有，带上会把文件撑到几十 MB', async () => {
    const deps = testDeps();
    await addEntry(createApp(deps), 'thin');
    const b = await (await createApp(deps).request('/api/backup')).json();
    expect(JSON.stringify(b)).not.toContain('.mp3');
  });

  it('导进一份新机器的备份 → 记录进来了', async () => {
    const src = testDeps();
    await addEntry(createApp(src), 'thin');
    await seed(src, 'thin', 's ɪ n');
    const b = await (await createApp(src).request('/api/backup')).json();

    const dst = testDeps();
    const r = await (await createApp(dst).request('/api/backup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    })).json();
    expect(r.added).toBe(1);
    const stats = await (await createApp(dst).request('/api/stats')).json();
    expect(stats.overall.attempts).toBe(1);
  });

  it('同一份备份导两次，不会把记录翻倍', async () => {
    const src = testDeps();
    await addEntry(createApp(src), 'thin');
    await seed(src, 'thin', 's ɪ n');
    const b = await (await createApp(src).request('/api/backup')).json();
    const post = () => createApp(src).request('/api/backup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    });
    await post();
    const second = await (await post()).json();
    expect(second.added, '重复导入把记录翻倍了').toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('导入不许抹掉本机已有的记录——它只加不减', async () => {
    const dst = testDeps();
    await addEntry(createApp(dst), 'thin');
    await seed(dst, 'thin', 'θ ɪ ŋ');           // 本机自己练的一次

    const src = testDeps();
    await addEntry(createApp(src), 'click');
    await seed(src, 'click', 'k l ɪ k');
    const b = await (await createApp(src).request('/api/backup')).json();

    await createApp(dst).request('/api/backup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    });
    const stats = await (await createApp(dst).request('/api/stats')).json();
    expect(stats.overall.attempts, '本机那次被抹掉了').toBe(2);
  });

  it('格式不对 / 版本对不上 → 直接拒绝，不猜着往库里灌', async () => {
    const deps = testDeps();
    for (const bad of [{ version: 2, entries: [], attempts: [] }, { entries: [] }, {}]) {
      const r = await createApp(deps).request('/api/backup', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad),
      });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await (await createApp(deps).request('/api/stats')).json()).overall.attempts).toBe(0);
  });

  /**
   * 备份里的词条带着**对面那台机器**算出来的推导结果（音素、音节、标签）。
   * 两边版本不一样时，导进来的就是按对面的规则算的——而本机的重算只在**启动时**跑一次，
   * 导入发生在那之后，于是这些词条会一直带着外来的旧标签，直到下次重启。
   *
   * 后果跟当初 judge 缺 final-voiced 一模一样：讲那个结构的笔记在这个词上永远不出现。
   */
  it('导进来的词条：推导结果按本机当前规则重算，不照单全收', async () => {
    const dst = testDeps();
    const words = analyzeText('click');
    const stale = words.map((w) => ({ ...w, tags: w.tags.filter((t) => !t.startsWith('cluster-onset:')) }));
    expect(stale[0].tags, '前提：造出来的旧结果确实没有这个标签').not.toContain('cluster-onset:kl');

    await createApp(dst).request('/api/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        entries: [{ text: 'click', words: stale, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
        attempts: [],
      }),
    });

    const d = await (await createApp(dst).request('/api/entries/click')).json();
    expect(d.words[0].tags, '导进来的词条还带着对面那台机器的旧标签').toContain('cluster-onset:kl');
    expect(d.notes.map((n: { id: string }) => n.id), '于是讲这个连缀的笔记在这个词上不出现')
      .toContain('kl-cluster');
  });

  // 重算那一步不能顺手把手工音标算没了——判据在 reanalyze.ts，这里守的是
  // 「导入这条路上真的用了那个判据」，而不是另写了一份宽松的。
  it('导入重算时，词典查不到的词照样保住手工音标', async () => {
    const dst = testDeps();
    const words = analyzeText('anthropic', '/ænˈθrɑpɪk/');
    expect(words[0].found, '前提：这个词确实不在 CMUdict 里').toBe(false);

    await createApp(dst).request('/api/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        entries: [{ text: 'anthropic', words, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
        attempts: [],
      }),
    });

    const d = await (await createApp(dst).request('/api/entries/anthropic')).json();
    expect(d.words[0].ipa, '手工音标被重算冲掉了').toBe('/ænˈθrɑpɪk/');
  });

  /**
   * 导入对已有词条是 `upsertEntry` —— 导进来的那一份**直接盖掉本机的**。
   *
   * 对普通词无所谓（两边都是词典算的，一模一样），坏在**手工音标**上：
   * 词典查不到的词，音标是人一个字一个字敲进去的，而它没有单独存，
   * 就写在那个 `found: false` 的词的 ipa 字段里。对面那台机器没敲过 → 空串 →
   * 一次「合并」把本机敲过的抹掉，而这个动作的典型场景恰恰是"两台机器合起来"。
   *
   * 反过来也要成立：本机没敲、对面敲过，那就该把对面那份收下。
   * 规则一句话：**谁有手工音标听谁的，都有或都没有就本机赢**（跟复习进度同一条）。
   */
  it('导入不许拿一份没手工音标的词条盖掉本机敲过的', async () => {
    const dst = testDeps();
    await createApp(dst).request('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'anthropic', ipaOverride: '/ænˈθrɑpɪk/' }),
    });
    const before = await (await createApp(dst).request('/api/entries/anthropic')).json();
    expect(before.words[0].ipa, '前提：本机这份带着手工音标').toBe('/ænˈθrɑpɪk/');

    // 对面那台只是查了一下这个词，没给音标
    const bare = analyzeText('anthropic');
    expect(bare[0].ipa, '前提：没给音标就是空的').toBe('');
    await createApp(dst).request('/api/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        entries: [{ text: 'anthropic', words: bare, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
        attempts: [],
      }),
    });

    const after = await (await createApp(dst).request('/api/entries/anthropic')).json();
    expect(after.words[0].ipa, '本机手敲的音标被一份空的盖掉了').toBe('/ænˈθrɑpɪk/');
  });

  it('反过来：本机没敲、备份里敲过 → 收下', async () => {
    const dst = testDeps();
    await addEntry(createApp(dst), 'anthropic');

    const typed = analyzeText('anthropic', '/ænˈθrɑpɪk/');
    await createApp(dst).request('/api/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        entries: [{ text: 'anthropic', words: typed, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
        attempts: [],
      }),
    });

    const after = await (await createApp(dst).request('/api/entries/anthropic')).json();
    expect(after.words[0].ipa, '备份里有音标、本机没有，却没收下').toBe('/ænˈθrɑpɪk/');
  });

  /**
   * 笔记归属**不进备份**——它是派生的（错误行 + 这次念的词 + 本机的 notes/）。
   *
   * 老版本带着它走，于是导出那台机器的匹配规则跟着一起搬家：用真实库跑过一次往返，
   * 182 条证据里 22 条来自"一处错都没有"的录音，导进新机器一条不落。
   * 而 notes/ 是跟着 git 走的，两台机器的笔记本来就未必是同一版。
   *
   * 现在导完由本机重算（reconcile.ts）。老备份里那个字段直接忽略。
   */
  it('备份不带笔记归属，导进来之后由本机自己算', async () => {
    const dst = testDeps();
    await createApp(dst).request('/api/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        exportedAt: '2026-01-01T00:00:00Z',
        entries: [],
        attempts: [
          // 全对的那次。老备份里它照样带着一条 noteIds——这里原样放进去，
          // 就是要看本机会不会被它带偏
          { entryText: 'machine', target: 'machine', at: '2026-01-01T00:00:00Z', targetIpa: 'm ə ʃ i n', heardIpa: 'm ə ʃ i n', clean: 1, errors: [], noteIds: ['ine-spelling'] },
          // 真错了的那次：本机自己会算出这篇该挂
          { entryText: 'machine', target: 'machine', at: '2026-01-01T00:00:01Z', targetIpa: 'm ə ʃ i n', heardIpa: 'm ə ʃ aɪ n', clean: 0, errors: [{ kind: 'sub', targetIpa: 'i', heardIpa: 'aɪ', atIndex: 3 }], noteIds: ['ine-spelling'] },
        ],
      }),
    });

    expect(overallStats(dst.db).attempts, '两次录音本身照收——不收的是归属，不是记录').toBe(2);
    expect(noteEvidence(dst.db).get('ine-spelling'), '备份里的归属被照单全收了')
      .toEqual({ count: 1, words: 1 });
  });

  it('导出的备份里没有笔记归属这一项', async () => {
    const deps = testDeps();
    await addEntry(createApp(deps), 'night');
    await seed(deps, 'night', 'l aɪ t');           // n→l，fixture 里 l-vs-n 教得了
    const b = await (await createApp(deps).request('/api/backup')).json();
    expect(noteEvidence(deps.db).size, '前提：本机确实算出了归属').toBeGreaterThan(0);
    expect(b.attempts[0]).not.toHaveProperty('noteIds');
    // 反过来，重算要用的两样必须带上，否则导进去的一方永远算不出结构类的归属
    expect(b.attempts[0].target, '不知道当时念的是哪个词，words: 笔记就没法重算').toBe('night');
    expect(b.attempts[0].errors[0]).toHaveProperty('atIndex');
  });

  /**
   * 缺了重算归属要用的东西就拒掉，**不补默认值**。
   *
   * 两种补法都是"看着成功的失败"：`target` 补成整条，讲那个词的笔记就全部落空
   * （这个默认值真的写过一次，96 条录音里 73 条被填错，讲 -ine 的那篇从 37 条
   * 证据掉到 4 条）；`atIndex` 补成 0，结构标签会被安到第一个音上。
   */
  it('录音记录缺 target 或 atIndex → 拒掉，不补一个默认值', async () => {
    const deps = testDeps();
    const ok = { entryText: 'machine', target: 'machine', at: '2026-01-01T00:00:00Z', targetIpa: 'm ə ʃ i n', heardIpa: 'm ə ʃ aɪ n', clean: 0, errors: [{ kind: 'sub', targetIpa: 'i', heardIpa: 'aɪ', atIndex: 3 }] };
    const bads = [
      { ...ok, target: undefined },
      { ...ok, target: '' },
      { ...ok, errors: [{ kind: 'sub', targetIpa: 'i', heardIpa: 'aɪ' }] },
    ];
    for (const bad of bads) {
      const r = await createApp(deps).request('/api/backup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, exportedAt: 'x', entries: [], attempts: [bad] }),
      });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(overallStats(deps.db).attempts, '拒了却还是灌了半截进去').toBe(0);
  });

  it('body 根本不是 JSON → 也是 400，不是 500', async () => {
    const deps = testDeps();
    const r = await createApp(deps).request('/api/backup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '这不是 json',
    });
    expect(r.status).toBe(400);
  });
});

describe('多用户 API', () => {
  it('GET /api/user 报当前用户和列表', async () => {
    const res = await createApp(testDeps()).request('/api/user');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: '默认', users: ['默认'] });
  });

  it('POST /api/user：不存在的用户 404，不自动新建', async () => {
    const deps = testDeps();
    (deps.users.switchTo as ReturnType<typeof vi.fn>).mockReturnValue('not-found');
    const res = await createApp(deps).request('/api/user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '没这人' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/user：非法名 400，报的是 invalidUserName 的真实理由；缺 name 400', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const bad = await app.request('/api/user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../x' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: invalidUserName('../x') });
    // 判据只在 invalidUserName 一处：名字已经被拦下，根本不该走到 switchTo
    expect(deps.users.switchTo).not.toHaveBeenCalled();
    const missing = await app.request('/api/user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(missing.status).toBe(400);
  });

  it('POST /api/users：新建成功回列表；重名 400', async () => {
    const deps = testDeps();
    const ok = await createApp(deps).request('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '张三' }),
    });
    expect(ok.status).toBe(200);
    (deps.users.create as ReturnType<typeof vi.fn>).mockReturnValue('exists');
    const dup = await createApp(deps).request('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '张三' }),
    });
    expect(dup.status).toBe(400);
  });
});
