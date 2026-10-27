import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');

describe('启动脚本不再各自拉边车', () => {
  it('npm start 只起服务；dev 用包装脚本关掉服务的自启', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.start).not.toContain('concurrently');
    expect(pkg.scripts.start).not.toContain('asr');
    expect(pkg.scripts.dev).toContain('scripts/dev-server.mjs');
    expect(pkg.scripts.dev).toContain('npm run --silent asr');
  });
});
