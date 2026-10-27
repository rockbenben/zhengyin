import { expect, it } from 'vitest';
import { CSP } from './csp.js';

it('CSP 允许 antd 的内联样式、录音 blob、vosk 的 wasm worker，同时关掉外部脚本', () => {
  expect(CSP).toContain("default-src 'self'");
  expect(CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(CSP).toContain("style-src 'self' 'unsafe-inline'");
  expect(CSP).toContain("media-src 'self' blob:");
  expect(CSP).toContain("worker-src 'self' blob:");
  expect(CSP).toContain("object-src 'none'");
});
