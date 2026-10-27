/**
 * 生产页面（由服务托管的 web/dist）的 CSP。
 *
 * - antd 6 用 CSS-in-JS 注入 <style>，所以 style-src 必须放行 inline；
 * - 录音回放用 blob:，Vosk 备用模型用 Web Worker + WebAssembly；
 * - 其余一律回到 'self'：应用自己的 API、音频、词典都同源。
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
