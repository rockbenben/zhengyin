import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverPort, localUrl, DEFAULT_PORT } from './port.js';

/**
 * 端口是 `.env` 里可以改的（PORT=30041），可它曾经**写死在给用户看的文字里**：
 *   · profile.ts 往发音档案里写「完整数据：curl http://localhost:30031/api/stats」
 *   · Recorder.tsx 的 toast 写「换成 http://localhost:30031 打开就行」
 * 改过端口的人照着做，两条都是错的。
 *
 * 而前端另有一处是**对的**（同一情形下面那条 Notice 用的是 location.port）——
 * 也就是**同一句话两个实现、其中一个错**，这个仓库最典型的一种坏法。
 */
const original = process.env.PORT;
afterEach(() => {
  if (original === undefined) delete process.env.PORT;
  else process.env.PORT = original;
});

describe('端口只有一个来源', () => {
  it('没设 PORT → 用默认', () => {
    delete process.env.PORT;
    expect(serverPort()).toBe(DEFAULT_PORT);
    expect(localUrl()).toBe(`http://localhost:${DEFAULT_PORT}`);
  });

  it('设了 PORT → 用它，写出来的网址也跟着变', () => {
    process.env.PORT = '30041';
    expect(serverPort()).toBe(30041);
    expect(localUrl()).toBe('http://localhost:30041');
  });

  it('PORT 是空串或非数字 → 退回默认，不产出 NaN 的网址', () => {
    for (const bad of ['', 'abc', ' ']) {
      process.env.PORT = bad;
      expect(serverPort(), `PORT=${JSON.stringify(bad)}`).toBe(DEFAULT_PORT);
      expect(localUrl()).not.toContain('NaN');
    }
  });
});

/**
 * 别处不许再写死这个端口。
 *
 * 上面三条只证明 `localUrl()` 自己是对的——**证不了有没有人绕过它**。
 * 试过写一条端到端的（渲染发音档案再查网址），那条是**空过的**：
 * 没有评测记录时那句 curl 根本不渲染，`not.toContain` 自然成立。
 *
 * 所以改成扫源码：除了 port.ts / brand.ts（默认值住在那儿）和注释里，
 * 谁都不许把 `localhost:<默认端口>` 写进代码。
 */
describe('端口不许在别处写死', () => {
  const NEEDLE = `localhost:${DEFAULT_PORT}`;

  /** 去掉注释——注释里提端口是在解释，不是在拼网址 */
  function code(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
  }

  function offenders(dir: string, keep: RegExp, allow: string): string[] {
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => keep.test(f) && !f.includes('.test.') && !f.endsWith(allow));
    expect(files.length, `一个文件都没扫到（${dir}）——目录读错了？`).toBeGreaterThan(5);
    return files.filter((f) => code(readFileSync(join(dir, f), 'utf8')).includes(NEEDLE));
  }

  it('server 源码里只有 port.ts 能出现它', () => {
    expect(offenders(import.meta.dirname, /\.ts$/, 'port.ts'), '这些文件把端口写死了').toEqual([]);
  });

  it('web 源码里只有 brand.ts 能出现它', () => {
    const dir = join(import.meta.dirname, '..', '..', 'web', 'src');
    expect(offenders(dir, /\.tsx?$/, 'brand.ts'), '这些文件把端口写死了').toEqual([]);
  });
});
