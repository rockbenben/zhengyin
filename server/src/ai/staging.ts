import { cpSync, existsSync, mkdirSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.js';
import { NoteStore } from '../notes.js';
import type { AgentSnapshotDeps, Snapshot } from './agent.js';

const read = (path: string): string | null => existsSync(path) ? readFileSync(path, 'utf8') : null;
const isNoteFile = (name: string): boolean => /^[^/\\]+\.md$/.test(name);

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
  if (existsSync(source.localNotes)) {
    for (const [name, content] of files(source.localNotes, false)) {
      writeFileAtomic(join(localNotes, name), content);
    }
  }
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

function files(dir: string, strict = true): Map<string, string> {
  if (lstatSync(dir).isSymbolicLink()) throw new Error('整理目录不能是符号链接');
  const result = new Map<string, string>();
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!item.isFile() || !isNoteFile(item.name)) {
      if (strict) throw new Error(`整理产物必须是普通 Markdown 文件：${item.name}`);
      continue;
    }
    result.set(item.name, readFileSync(join(dir, item.name), 'utf8'));
  }
  return result;
}

const EDITABLE_SECTIONS = /^## (已确认的习惯问题|待观察)[^\S\r\n]*\r?\n[\s\S]*?(?=^## |^<!-- AUTO:|$(?![\s\S]))/gm;

function editableSections(text: string): { skeleton: string; sections: Map<string, string> } {
  const sections = new Map<string, string>();
  const skeleton = text.replace(EDITABLE_SECTIONS, (block, name: string) => {
    if (sections.has(name)) throw new Error('档案存在重复小节');
    sections.set(name, block);
    return `@@${name}@@\n`;
  });
  return { skeleton, sections };
}

export interface ProfileChange {
  section: string;
  before: string;
  after: string;
}

export function undoProfileSections(profileFile: string, changes: ProfileChange[]): string[] {
  if (changes.length === 0) return [];
  const current = read(profileFile);
  if (current === null) return ['档案已被移除，保留现状'];
  const sections = new Map<string, string | null>();
  for (const [block, name] of current.matchAll(EDITABLE_SECTIONS)) {
    sections.set(name, sections.has(name) ? null : block);
  }
  const restored = new Map<string, string>();
  const conflicts: string[] = [];
  for (const change of changes) {
    if (sections.get(change.section) === change.after) restored.set(change.section, change.before);
    else conflicts.push(`保留档案的后续编辑：${change.section}`);
  }
  if (restored.size > 0) {
    writeFileAtomic(profileFile, current.replace(EDITABLE_SECTIONS, (block, name: string) => restored.get(name) ?? block));
  }
  return conflicts;
}

/**
 * 把工作副本里通过校验的改动提交到本机数据。
 *
 * 先整批验证、再逐篇写盘：笔记交给 `NoteStore` 复查规则，档案只合并「已确认的习惯问题」
 * 「待观察」两节（其余内容含 AUTO 块按原件保留），原件在这期间被改过就整批拒绝。
 * 两个回调分别记录写成功的笔记和档案小节。磁盘写入中途失败时，
 * 已经写下的文件会留着，撤销按实际提交的改动回滚。
 */
export function commitAgentWorkspace(
  staged: AgentSnapshotDeps,
  live: AgentSnapshotDeps,
  before: Snapshot,
  onNoteCommitted: (name: string) => void = () => {},
  onProfileCommitted: (changes: ProfileChange[]) => void = () => {},
): void {
  const candidates = files(staged.localNotes);
  const originals = files(live.localNotes, false);
  const store = new NoteStore([{ dir: staged.localNotes, source: 'local' }]);
  store.load();
  if (store.warnings.length) throw new Error(`整理笔记未通过校验：${store.warnings.join('；')}`);
  const changes = [...new Set([...Object.keys(before.notes), ...candidates.keys()])]
    .filter(name => isNoteFile(name) && before.notes[name] !== candidates.get(name));
  for (const name of changes) {
    if (originals.get(name) !== before.notes[name]) throw new Error(`笔记已被修改，保留原件：${name}`);
  }
  if (existsSync(staged.profileFile) && !lstatSync(staged.profileFile).isFile()) throw new Error('整理档案必须是普通文件');
  const candidateProfile = read(staged.profileFile);
  let mergedProfile: string | null = null;
  const profileChanges: ProfileChange[] = [];
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
      profileChanges.push({ section: name, before: original, after: next });
      c.sections.set(name, next);
    }
    mergedProfile = current.replace(EDITABLE_SECTIONS, (_, name: string) => c.sections.get(name)!);
  }
  for (const name of changes) {
    const target = join(live.localNotes, name);
    const content = candidates.get(name);
    if (content === undefined) { if (existsSync(target)) unlinkSync(target); }
    else writeFileAtomic(target, content);
    onNoteCommitted(name);
  }
  if (mergedProfile !== null) {
    writeFileAtomic(live.profileFile, mergedProfile);
    onProfileCommitted(profileChanges);
  }
}
