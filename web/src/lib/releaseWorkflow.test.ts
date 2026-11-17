import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const workflow = readFileSync(
  join(import.meta.dirname, '../../..', '.github/workflows/release.yml'), 'utf8',
).replace(/\r\n/g, '\n');
const step = workflow.match(/      - name: 建\/复用草稿并上传\n        run: \|\n((?: {10}[^\n]*\n)+)/)?.[1];
if (!step) throw new Error('找不到发布草稿步骤');
const script = step.replace(/^ {10}/gm, '');

// Windows 用 Git 自带的 Bash，避免调用 PATH 上可能指向 WSL 的 bash.exe。
const bash = process.platform === 'win32'
  ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..', 'bin', 'bash.exe')
  : 'bash';

const notes = '## 本次更新\n\n- 修复备份导入。\n- 保留 `音标` 与标点。\n';
const fakeGh = `
gh() {
  [[ "$1" = release && "$3" = "$TAG" && "$4" = -R && "$5" = "$REPO" ]] || return 10
  printf '%s\\n' "$2" >> calls
  case "$2" in
    view)
      [[ "$SCENARIO" != missing ]] || return 1
      if [[ "$SCENARIO" = published ]]; then printf 'false\\n'; else printf 'true\\n'; fi
      ;;
    create|edit)
      [[ "$SCENARIO" != edit_failed ]] || return 9
      while [[ "$#" -gt 0 && "$1" != --notes-file ]]; do shift; done
      [[ "$#" -ge 2 && "$2" = "docs/releases/$TAG.md" ]] || return 11
      /usr/bin/cat "$2" > saved-body
      ;;
    upload) ;;
    *) return 12 ;;
  esac
}
`;

it.each([
  { scenario: 'draft', calls: 'view\nedit\nupload\n', status: 0 },
  { scenario: 'missing', calls: 'view\ncreate\nupload\n', status: 0 },
  { scenario: 'published', calls: 'view\n', status: 1 },
  { scenario: 'edit_failed', calls: 'view\nedit\n', status: 9 },
])('发布草稿步骤 $scenario', ({ scenario, calls, status }) => {
  const root = mkdtempSync(join(tmpdir(), 'zhengyin-release-test-'));
  const tag = 'v1.2.3';
  try {
    mkdirSync(join(root, 'docs', 'releases'), { recursive: true });
    writeFileSync(join(root, 'docs', 'releases', `${tag}.md`), notes);
    writeFileSync(join(root, 'saved-body'), '过期的草稿正文\n');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-s'], {
      cwd: root, input: fakeGh + script, encoding: 'utf8',
      env: { ...process.env, TAG: tag, REPO: 'example/zhengyin', SCENARIO: scenario },
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(status);
    expect(readFileSync(join(root, 'calls'), 'utf8')).toBe(calls);
    expect(readFileSync(join(root, 'saved-body'), 'utf8')).toBe(status === 0 ? notes : '过期的草稿正文\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
