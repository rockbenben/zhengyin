import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 中文散文的排版规矩（仓库级）——**正本在 `AGENTS.md` 的「中文散文的排版」那一节**，
 * 这里是它的守卫。
 *
 * 一、散文里不用 ASCII 双引号、不用弯引号，一律用「」。
 * 二、汉字后面不跟半角 , ; ! ?。
 *
 * 两条都只管**散文**：代码块（``` 围栏）、行内代码（`…`）、以及
 * 启动脚本（`.cmd`/`.sh`/`.command`）里的引号一律不碰——
 * 那些是**语法**：`cd /d "%~dp0"`、`for /f "tokens=5"`、`"$port"`。
 * 把它们换成中文引号，脚本立刻改坏（实测过一轮）。
 *
 * **没有**「中文之间不留半角空格」这一条：它有正当例外，理由见 AGENTS.md。
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');

/** 只有散文进这道检查 */
const PROSE = /\.(md|txt)$/;

/**
 * 历史设计稿（`docs/superpowers/`）不在检查范围内。
 *
 * 那是**当时的决定记录**，不是给现在的人读的文案：里面嵌着 shell 命令片段，
 * 那些引号是**语法**（`\"${uvPath}\" --version`），换成中文引号就把片段改坏了。
 * 文档记录历史，不回改。
 */
const isProse = (f: string) => PROSE.test(f) && !f.startsWith('docs/superpowers/');

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .map((s) => s.trim())
      .filter((s) => s && existsSync(join(ROOT, s)));
  } catch {
    return [];
  }
}

/** 把代码围栏和行内代码挖掉，剩下的才是给人读的散文 */
function proseOf(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inFence = false;
  src.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const text = line.split(/(`[^`]*`)/g).filter((p) => !p.startsWith('`')).join('');
    if (text.trim()) out.push({ line: i + 1, text });
  });
  return out;
}

describe('中文散文的排版', () => {
  const files = trackedFiles().filter(isProse);

  it('散文中不用 ASCII 双引号、不用弯引号，一律用「」', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const { line, text } of proseOf(readFileSync(join(ROOT, f), 'utf8'))) {
        if (text.includes('"') || /[“”]/.test(text)) {
          bad.push(`${relative(ROOT, f)}:${line}  ${text.trim().slice(0, 60)}`);
        }
      }
    }
    expect(bad, '这些地方还留着别的引号（散文里统一用「」）').toEqual([]);
  });

  it('汉字后面不跟半角 , ; ! ?', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const { line, text } of proseOf(readFileSync(join(ROOT, f), 'utf8'))) {
        const m = text.match(/[一-鿿][,;!?](?![0-9a-zA-Z])/);
        if (m) bad.push(`${relative(ROOT, f)}:${line}  ${text.trim().slice(0, 60)}`);
      }
    }
    expect(bad, '中文句子里的标点要全角').toEqual([]);
  });

  // **没有**「中文之间不留半角空格」这一条：它有正当例外——
  //   · AGENTS.md 里引用的界面图例「颜色越深 错得越多」；
  //   · antd 两字按钮的「评 测」；
  //   · 笔记里的重音节奏「强-弱-弱 强-弱」。
  // 中文之间确实有时要留白，这条判据太粗，留着只会逼人把对的改错。
});
