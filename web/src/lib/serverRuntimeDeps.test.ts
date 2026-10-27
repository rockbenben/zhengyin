import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverRuntimeResources } from '../../../scripts/server-runtime-deps.mjs';

function pkg(dir: string, name: string, deps: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: deps }));
}

describe('server-runtime-deps 的资源路径', () => {
  it('装在 server/node_modules 里的包不会被复制到 server/server/', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-deps-'));
    pkg(join(root, 'server'), 'server', { a: '1', c: '1' });
    pkg(join(root, 'server', 'node_modules', 'a'), 'a', { b: '1' });
    pkg(join(root, 'server', 'node_modules', 'a', 'node_modules', 'b'), 'b');
    pkg(join(root, 'node_modules', 'c'), 'c');

    const res = serverRuntimeResources(root);
    const norm = (p: string) => p.split('\\').join('/');
    const map = Object.fromEntries(res.map((x) => [norm(x.from), norm(x.to)]));

    expect(map['server/node_modules/a']).toBe('server/node_modules/a');
    expect(map['server/node_modules/a/node_modules/b'])
      .toBe('server/node_modules/a/node_modules/b');
    expect(map['node_modules/c']).toBe('server/node_modules/c');
    expect(res.some((x) => norm(x.to).startsWith('server/server/'))).toBe(false);
  });
});
