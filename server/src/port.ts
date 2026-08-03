/** 这个应用默认的端口。理由见 index.ts 顶上那段（30000–49151 那一段基本没人用） */
export const DEFAULT_PORT = 30031;

/**
 * 服务实际监听在哪个端口。
 *
 * **写成函数、不写成顶层常量**：`process.env.PORT` 要等 `dotenv/config` 跑完才有值，
 * 而 ESM 的 import 是提前求值的——顶层常量可能在 dotenv 之前就把默认值定死了。
 *
 * ── 为什么要有这个模块 ──
 *
 * 端口是 `.env` 里可以改的（PORT=30041），可 30031 曾经**写死在给用户看的文字里**：
 *   · profile.ts 往发音档案里写「完整数据：curl http://localhost:30031/api/stats」
 *   · Recorder.tsx 的提示写「换成 http://localhost:30031 打开就行」
 * 改过端口的人照着做，两条都是错的。前端另有一处是对的（用 location.port 取当前端口），
 * 也就是**同一句话有两个实现、其中一个错**——这个仓库最典型的一种坏法。
 */
export function serverPort(): number {
  return Number(process.env.PORT) || DEFAULT_PORT;
}

/** 本机访问这个应用的地址。发音档案、报错提示里要写网址时都用它 */
export function localUrl(): string {
  return `http://localhost:${serverPort()}`;
}
