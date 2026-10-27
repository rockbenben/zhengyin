import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 中文句子中间不许多一个空格。
 *
 * **JSX 会把「换行 + 缩进」折成一个半角空格**：一段中文跨行写，渲染出来就是
 * 「因为这个词里有 词首的 /kl/ 连缀」——中间一个豁口。类型检查看不出来，
 * DOM 里那个空格确实存在，只有把中文并到一行、或裹进 `{'...'}` 才不出现。
 *
 * 仓库的规矩写在 `components/HowItWorks.tsx` 的注释里（中文一律裹进 `{'...'}`，
 * 不要让它跨行）。这条测试就是那道规矩的守卫：谁再让一段中文跨行，这里就红。
 *
 * ── 判据怎么定的 ──
 *
 * 只有**同一个 JSXText 节点里**的换行才折出空格；元素/表达式之间的换行会被 JSX
 * 去掉（首尾的空白都裁掉）。所以判据是：上一行末尾是汉字（或中文标点）、
 * 下一行开头也是汉字，中间没有元素或表达式挡着。
 */
const srcRoot = join(import.meta.dirname, '..');

/** 汉字与中文标点——它们之间不该有空格 */
const CJK = '一-鿿：，。、；！？（）「」『』…—';
const tail = new RegExp(`([${CJK}])\\s*$`);
const head = new RegExp(`^\\s*([${CJK}])`);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (p.endsWith('.tsx') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * 把注释挖掉、**把字符串内容换成 x**，行结构原样保留。
 *
 * 换掉字符串内容有两个用处：
 *   · `{'中文'}` 这种已经裹好的中文不该被当成 JSX 文本再判一次；
 *   · 跨行的模板字符串不会在中间断开（它的内容已经被换掉了），不会误报。
 * 而 JSX 文本不是字符串，内容原样留着——那正是要判的地方。
 */
function blankOut(src: string): string {
  let out = '';
  let i = 0;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inBlock) {
      if (c === '*' && next === '/') { out += '  '; i += 2; inBlock = false; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (c === '/' && next === '*') { out += '  '; i += 2; inBlock = true; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += 'xx'; i += 2; continue; }
        if (src[i] === quote) { out += quote; i++; break; }
        if (src[i] === '\n') { out += '\n'; i++; break; }   // 跨行字符串：留行结构
        out += 'x';
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

describe('中文不许跨行写', () => {
  it('跨行的中文会折出一个半角空格，渲染出来中间是个豁口', () => {
    const bad: string[] = [];
    for (const file of tsxFiles(srcRoot)) {
      const lines = blankOut(readFileSync(file, 'utf8')).split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        const m = lines[i].match(tail);
        const nm = lines[i + 1].match(head);
        if (!m || !nm) continue;
        // 下一行以元素/表达式开头 → 是边界，JSX 会把那点空白裁掉
        if (/^\s*[{}<>)\]]/.test(lines[i + 1])) continue;
        // 上一行以标签/属性/表达式收尾 → 那不是 JSX 文本
        if (/[=<>({,]\s*$/.test(lines[i])) continue;
        if (/\}\s*$/.test(lines[i])) continue;
        bad.push(`${relative(srcRoot, file)}:${i + 1}  「${m[1]}」␣「${nm[1]}」`);
      }
    }
    expect(
      bad,
      '这些地方的中文跨了行：把中文裹进 {\'...\'}（每一段各占一行），或者并到一行。',
    ).toEqual([]);
  });
});
