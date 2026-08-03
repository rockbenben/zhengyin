import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 起子进程时，`shell: true` **不能配参数数组**——Node 24 起会打 DEP0190 到 stderr，
 * 而那正是双击启动那个窗口。用户第一屏看到一句英文的 "security vulnerabilities"，
 * 多半以为出事了。
 *
 * 改法不是删 `shell: true`（Windows 上 uv 可能是 .cmd shim，不走 shell 就 ENOENT），
 * 而是把命令整串传：`spawn('uv --version', { shell: true })`。
 *
 * 扫源码而不是跑一遍：告警只在特定 Node 版本出现，而这个写法本身就该是对的。
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');
const DIRS = ['server/src', 'web/src', 'scripts'];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('起子进程：shell:true 不许配参数数组', () => {
  it('全仓没有 spawn/spawnSync/execFile(命令, [参数], { shell: true })', () => {
    const offenders: string[] = [];
    for (const f of DIRS.flatMap(sources)) {
      if (f.endsWith('spawnShell.test.ts')) continue;          // 本文件自己举了反例
      const src = readFileSync(join(ROOT, f), 'utf8');
      // 注释里可以写这个反例，只扫真代码
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      for (const m of code.matchAll(/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/g)) {
        const tail = code.slice(m.index, m.index + 600);
        if (/\(\s*[^,]+,\s*\[/.test(tail) && /shell:\s*true/.test(tail)) {
          offenders.push(`${f} → ${m[1]}(命令, [参数], { shell: true })`);
        }
      }
    }
    expect(offenders, `这么写会往用户窗口里打 DEP0190（"security vulnerabilities"）。\n`
      + `把命令整串传即可，shell:true 留着：\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('这条扫描确实扫得到东西——不然它就是个空断言', () => {
    const files = DIRS.flatMap(sources);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('scripts/asr.mjs');
    expect(files).toContain('scripts/check-uv.mjs');
    expect(files).toContain('server/src/audio/phonemeAsr.ts');
  });
});
