import { spawnSync } from 'node:child_process';
// 调本地音素识别边车（asr-service）。
//
// 边车是哑服务：音频进，原始 eSpeak IPA 串出。归一化、跟目标词对齐、挂笔记全在 Node 侧，
// 因为本项目的 IPA 集合定义在 analysis/phones.ts，那份知识只该有一处。
//
// 边车要单独起（npm run asr），**忘了起是常态**——所以"连不上"必须是一个正常返回值
// （reachable: false），不是异常。调用方据此退回 vosk 二选一，而不是让评测整个失效。

// 30032 跟 package.json 里 asr 那条命令的 --port 写死在两处，改要一起改。
// 没做成环境变量：uvicorn 的 --port 优先于环境变量，做出来的开关不会生效，
// 而一个不生效的开关比没有开关更糟。这是内部端口，真撞上的概率也低——
// 撞了的话界面上"服务没启动"那条提示会出来，照它说的看终端日志就能定位。
const ENDPOINT = 'http://127.0.0.1:30032';

export interface PhonemeAsrResult {
  reachable: boolean;
  /** 边车返回的原始 eSpeak IPA 串，如 "n aɪ t"；连不上或出错时为 null */
  ipa: string | null;
  /**
   * 逐音素置信度，顺序跟 ipa 里的 token 一一对应。
   * 可选是因为旧版边车（没有 phone_confidences 之前的）不返回它——调用方必须把
   * "拿不到置信度"当成合法情况处理，退化成"每个音都当成确定的"，而不是崩掉或全判成不确定。
   */
  phones: Array<{ ipa: string; conf: number }> | null;
  /** 连不上/出错的原因，给用户看的中文说明 */
  reason: string | null;
}

/**
 * @param audio 16kHz 单声道 WAV 字节（前端 clipToWavBlob 的产物；边车自己会补静音）
 * @param timeoutMs 超时。首次请求要等模型加载（实测冷启动约 13s，之后每次 0.1–0.3s），
 *   所以给得比一次推理宽得多——超时了报"太慢"比报"没装"更误导人。
 */
export async function recognizePhonemes(
  audio: Uint8Array,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 60_000,
): Promise<PhonemeAsrResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${ENDPOINT}/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // Uint8Array 直接当 body：Node 的 fetch 收 BodyInit，不用先转 Buffer/Blob
      body: audio as unknown as BodyInit,
      signal: ctl.signal,
    });
    if (!res.ok) {
      // 边车用 FastAPI 的 {"detail": "..."} 形状报错，取得到就透给用户
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json() as { detail?: unknown };
        if (typeof body.detail === 'string') detail = body.detail;
      } catch { /* 不是 JSON 就用状态码 */ }
      return { reachable: true, ipa: null, phones: null, reason: detail };
    }
    const body = await res.json() as { ipa?: unknown; phones?: unknown };
    if (typeof body.ipa !== 'string') {
      return { reachable: true, ipa: null, phones: null, reason: '边车返回的不是预期格式' };
    }
    const phones = Array.isArray(body.phones) && body.phones.every(
      (p: unknown) => typeof (p as { ipa?: unknown }).ipa === 'string'
        && typeof (p as { conf?: unknown }).conf === 'number',
    ) ? body.phones as Array<{ ipa: string; conf: number }> : null;
    return { reachable: true, ipa: body.ipa, phones, reason: null };
  } catch (e) {
    // 连不上（服务没起）和超时都走这里。两者对用户的意义不同，分开说：
    // 前者是"去起一下"，后者是"它在跑但太慢了"，给一样的提示会让人白折腾。
    const aborted = (e as { name?: string }).name === 'AbortError';
    return {
      reachable: false,
      ipa: null,
      phones: null,
      reason: aborted ? `音素识别超过 ${Math.round(timeoutMs / 1000)}s 还没结果` : '音素识别服务没启动',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 边车在不在。超时给得很短（2s）：这是给页面判断"该提示什么"用的，不能让它拖慢首屏；
 * 而且边车没起时 connect 会立刻失败，根本用不到超时。
 *
 * 注意它只说明进程在监听，**不代表模型加载完了**——边车冷启动要十几秒，那段时间
 * /health 会回 ok:false。据此提示"还在加载"比提示"没启动"准确。
 */
/**
 * 这台机器上有没有 uv。**没有的话边车永远起不来**，不是"还在加载"。
 *
 * 为什么值得单独报出来：界面在边车没就绪时说的是「正在加载模型，稍等十几秒」，
 * 熬满 90 秒才改口说"去看启动服务那个终端窗口"。而对一个**从没装过 uv/Python**
 * 的新用户，那 90 秒是纯粹的空等——答案启动时就知道，而且他多半是双击启动的，
 * 本来就是为了不碰终端，让他回去翻终端等于把他推开。
 *
 * 只在启动时查一次（index.ts），不每次请求都查：边车是被启动脚本拉起来的，
 * 中途装上 uv 也得重启才有用。判据跟 scripts/check-uv.mjs 一模一样。
 */
export function hasUv(): boolean {
  // 命令整串传，别写成 ('uv', ['--version'])——理由见 web/src/lib/spawnShell.test.ts
  return spawnSync('uv --version', { stdio: 'ignore', shell: true }).status === 0;
}

export async function checkPhonemeAsr(fetchFn: typeof fetch = fetch, timeoutMs = 2_000): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${ENDPOINT}/health`, { signal: ctl.signal });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
