import { cpSync, existsSync, mkdirSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';
import { NoteStore } from '../notes.js';
import type { AgentSnapshotDeps, Snapshot } from './agent.js';

const read = (path: string): string | null => existsSync(path) ? readFileSync(path, 'utf8') : null;

/**
 * Edits are made on copies (both API plans and CLI runs); only validated candidates reach the live files.
 * `includeReference` 只在命令行整理时为 true：接口整理把资料拼进消息，不铺 `.ai-reference`。
 */
export function prepareAgentWorkspace(root: string, source: AgentSnapshotDeps, notes: string, workflows: string, includeReference = true): AgentSnapshotDeps {
  mkdirSync(root, { recursive: true });
  root = realpathSync.native(root);
  const localNotes = join(root, 'data', 'notes');
  const profileFile = join(root, 'data', 'profile.md');
  mkdirSync(localNotes, { recursive: true });
  if (existsSync(source.localNotes)) cpSync(source.localNotes, localNotes, { recursive: true });
  const profile = read(source.profileFile);
  if (profile !== null) writeFileAtomic(profileFile, profile);
  if (includeReference) {
    const reference = join(root, '.ai-reference');
    mkdirSync(reference, { recursive: true });
    cpSync(notes, join(reference, 'notes'), { recursive: true });
    cpSync(workflows, join(reference, 'workflows'), { recursive: true });
  }
  return { appRoot: root, dataDir: join(root, 'data'), localNotes, profileFile };
}

function files(dir: string): Map<string, string> {
  if (lstatSync(dir).isSymbolicLink()) throw new Error('整理目录不能是符号链接');
  const result = new Map<string, string>();
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile() || !/^[^/\\]+\.md$/.test(item.name)) throw new Error(`整理产物必须是普通 Markdown 文件：${item.name}`);
    result.set(item.name, readFileSync(join(dir, item.name), 'utf8'));
  }
  return result;
}

function editableSections(text: string): { skeleton: string; sections: Map<string, string> } {
  const sections = new Map<string, string>();
  const skeleton = text.replace(/^## (已确认的习惯问题|待观察)[^\S\r\n]*\r?\n[\s\S]*?(?=^## |^<!-- AUTO:|$(?![\s\S]))/gm, block => {
    const name = /^## ([^\r\n]+)/.exec(block)![1];
    if (sections.has(name)) throw new Error('档案存在重复小节');
    sections.set(name, block);
    return `@@${name}@@\n`;
  });
  return { skeleton, sections };
}

/**
 * 把工作副本里通过校验的改动提交到本机数据。
 *
 * 先整批验证、再逐篇写盘：笔记交给 `NoteStore` 复查规则，档案只合并「已确认的习惯问题」
 * 「待观察」两节（其余内容含 AUTO 块按原件保留），原件在这期间被改过就整批拒绝。
 * 写成功的文件通过 `onCommitted` 报告（档案报 `null`）；磁盘写入中途失败时，
 * 已经写下的那几篇会留着，撤销只按报告过的改动回滚。
 */
export function commitAgentWorkspace(staged: AgentSnapshotDeps, live: AgentSnapshotDeps, before: Snapshot, onCommitted: (name: string | null) => void = () => {}): void {
  const candidates = files(staged.localNotes);
  const originals = files(live.localNotes);
  const store = new NoteStore([{ dir: staged.localNotes, source: 'local' }]);
  store.load();
  if (store.warnings.length) throw new Error(`整理笔记未通过校验：${store.warnings.join('；')}`);
  const changes = [...new Set([...Object.keys(before.notes), ...candidates.keys()])]
    .filter(name => before.notes[name] !== candidates.get(name));
  for (const name of changes) {
    if (originals.get(name) !== before.notes[name]) throw new Error(`笔记已被修改，保留原件：${name}`);
  }
  if (existsSync(staged.profileFile) && !lstatSync(staged.profileFile).isFile()) throw new Error('整理档案必须是普通文件');
  const candidateProfile = read(staged.profileFile);
  let mergedProfile: string | null = null;
  if (candidateProfile !== before.profile) {
    if (candidateProfile === null || before.profile === null) throw new Error('整理不能删除或替换档案');
    const a = editableSections(before.profile);
    const b = editableSections(candidateProfile);
    if (a.skeleton !== b.skeleton) throw new Error('整理改动了档案的允许小节以外内容');
    const current = read(live.profileFile);
    if (current === null) throw new Error('档案已被移除');
    const c = editableSections(current);
    for (const [name, original] of a.sections) {
      const next = b.sections.get(name)!;
      if (original === next) continue;
      if (c.sections.get(name) !== original) throw new Error(`档案小节已被修改：${name}`);
      c.sections.set(name, next);
    }
    mergedProfile = c.skeleton.replace(/@@(已确认的习惯问题|待观察)@@\n/g, (_, name: string) => c.sections.get(name)!);
  }
  for (const name of changes) {
    const target = join(live.localNotes, name);
    const content = candidates.get(name);
    if (content === undefined) { if (existsSync(target)) unlinkSync(target); }
    else writeFileAtomic(target, content);
    onCommitted(name);
  }
  if (mergedProfile !== null) {
    writeFileAtomic(live.profileFile, mergedProfile);
    onCommitted(null);
  }
}
