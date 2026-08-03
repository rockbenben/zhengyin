import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 界面文案里不许混进 markdown 记号——它们会**原样显示**在屏幕上。
 *
 * ── 踩到的两处 ──
 *
 *   Recorder    在**这台机器上**用 http://localhost:30031 打开就能录
 *   BackupSetting  跟着仓库走（`git clone` 或直接拷贝整个文件夹就带上了）
 *
 * 用户看到的就是带着星号和反引号的那一串。**两处都不是疏忽写错，是习惯**：
 * 这份代码的注释里到处是 `**...**` 和反引号，写 JSX 时手就顺下去了。
 * 更能说明问题的是 Recorder 那一处——**同一段 Notice 的上一行**用的是
 * 正确的 `<strong>`，两种写法并排活着，谁都没发现。
 *
 * 类型检查看不出来（那是合法的字符串），现有测试也碰不到（断言查的是关键词，
 * 而「**这台机器上**」照样含「这台机器上」）。只能靠扫源码。
 *
 * ── 判据 ──
 *
 * 只认两种机械形状，不假装能认出所有 markdown：
 *   1. 非注释行里出现 `**`
 *   2. 引号字符串（'…' / "…"）里出现成对的反引号
 *
 * 模板字符串的反引号是**定界符不是记号**，所以只查引号字符串内部；
 * `**` 在这个仓库的 tsx 里没有别的合法用途（乘方要写 ** 的话会被这条挡住，
 * 那时候把它挪进 .ts 或加一行说明即可）。
 *
 * 正文用 `<strong>`，代码用 `<Typography.Text code>`——两者页面上都有现成的例子。
 */
const SRC = join(import.meta.dirname, '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [p] : [];
  });
}

/** 返回 [行号, 说明]；扫的是「会被渲染出去的那部分」，注释一律跳过 */
export function markdownLeaks(source: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let inBlock = false;
  source.split(/\r?\n/).forEach((line, idx) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      return;
    }
    if (t.startsWith('/*') || t.startsWith('{/*') || t.startsWith('*') || t.startsWith('//')) {
      if ((t.startsWith('/*') || t.startsWith('{/*')) && !t.includes('*/')) inBlock = true;
      return;
    }
    if (line.includes('/*') && !line.includes('*/')) inBlock = true;
    // 行尾的 // 注释切掉，但别把 https:// 切了
    const code = line.includes('//') && !/https?:\/\//.test(line) ? line.split('//')[0] : line;
    if (code.includes('**')) out.push([idx + 1, '`**` 粗体记号会原样显示，正文强调用 <strong>']);
    for (const m of code.matchAll(/'[^']*'|"[^"]*"/g)) {
      if (/`[^`]+`/.test(m[0])) {
        out.push([idx + 1, '字符串里的反引号会原样显示，代码用 <Typography.Text code>']);
      }
    }
  });
  return out;
}

describe('界面文案里不许混进 markdown 记号', () => {
  const files = tsxFiles(SRC);

  it('前提：真的扫到了一批 tsx', () => {
    expect(files.length, '一个文件都没扫到，这条守卫是空的').toBeGreaterThan(15);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f] as const))(
    '%s',
    (_name, full) => {
      const leaks = markdownLeaks(readFileSync(full, 'utf8'));
      expect(leaks.map(([n, why]) => `第 ${n} 行：${why}`), '这些记号会显示给用户').toEqual([]);
    },
  );

  it('判据认得出这两种形状——不然上面一片绿也说明不了什么', () => {
    expect(markdownLeaks('<p>在**这台机器上**打开</p>')).toHaveLength(1);
    expect(markdownLeaks("{'跟着仓库走（`git clone` 就带上了）'}")).toHaveLength(1);
    // 模板字符串的反引号是定界符，不是记号
    expect(markdownLeaks('title={`已经查过 ${n} 个词`}')).toEqual([]);
    // 注释里怎么写都行——这份代码的注释本来就是 markdown 风格
    expect(markdownLeaks('// **这条规矩**是踩出来的\n/* `git clone` */')).toEqual([]);
  });
});
