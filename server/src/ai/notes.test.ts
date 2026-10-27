import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { openDb } from '../db.js';
import { NoteStore } from '../notes.js';
import { parseNoteDraft, saveAiNote, type AiNotesDeps, type NoteDraft } from './notes.js';

const BODY = '## 自检法\n捏住鼻子发，发得出声就是 /l/。\n\n## 对比训练\n中文「老 / 脑」先分清，再练 light / night。';

function fixture(seed?: { id: string; title: string; triggers: string[] }): AiNotesDeps & { shipped: string } {
  const shipped = mkdtempSync(join(tmpdir(), 'ai-notes-shipped-'));
  if (seed) {
    writeFileSync(join(shipped, `${seed.id}.md`), matter.stringify('讲 l 的笔记。\n', seed), 'utf8');
  }
  const localNotes = mkdtempSync(join(tmpdir(), 'ai-notes-local-'));
  const noteStore = new NoteStore([
    { dir: shipped, source: 'shipped' },
    { dir: localNotes, source: 'local' },
  ]);
  noteStore.load();

  const profileFile = join(mkdtempSync(join(tmpdir(), 'ai-notes-profile-')), '发音档案.md');
  writeFileSync(profileFile, '# 发音档案\n\n## 已确认的习惯问题\n（还没有）\n', 'utf8');

  return {
    db: openDb(':memory:'),
    noteStore,
    localNotes,
    profileFile,
    now: () => '2026-10-27T00:00:00Z',
    shipped,
  };
}

const draft = (over: Partial<NoteDraft> = {}): NoteDraft => ({
  title: 'l 和 n',
  scope: 'phoneme',
  values: ['l', 'n'],
  contrasts: [],
  body: BODY,
  ...over,
});

describe('parseNoteDraft', () => {
  it('接受 phoneme / word 两种 scope', () => {
    expect(parseNoteDraft(JSON.stringify(draft({ scope: 'phoneme' }))).scope).toBe('phoneme');
    expect(parseNoteDraft(JSON.stringify(draft({ scope: 'word', values: ['Machine'] })))).toMatchObject({
      scope: 'word', values: ['machine'],
    });
  });

  it('拒绝其它 scope', () => {
    expect(() => parseNoteDraft('{"title":"x","scope":"nope","values":["l"],"body":"## 自检法"}')).toThrow(/scope/);
  });

  it('剥掉模型给 IPA 加的壳，并去重', () => {
    const d = parseNoteDraft(JSON.stringify(draft({ values: ['/l/', '[n]', 'phoneme:l', 'n'] })));
    expect(d.values).toEqual(['l', 'n']);
    expect(parseNoteDraft(JSON.stringify(draft({ contrasts: ['/s/'] }))).contrasts).toEqual(['s']);
  });

  it('正文不能空', () => {
    expect(() => parseNoteDraft(JSON.stringify(draft({ body: '  ' })))).toThrow(/正文/);
  });
});

describe('saveAiNote', () => {
  it('写入本机笔记：frontmatter 由服务端拼，来源是 local', () => {
    const deps = fixture();
    const r = saveAiNote(deps, draft({ contrasts: ['s'] }));
    expect(r.id).toMatch(/^[a-z0-9-]+$/);
    expect(r.file).toBe(`${r.id}.md`);
    expect(deps.noteStore.get(r.id)?.source).toBe('local');

    const raw = readFileSync(join(deps.localNotes, `${r.id}.md`), 'utf8');
    expect(raw).toContain('triggers:');
    const parsed = matter(raw);
    expect(parsed.data.triggers).toEqual(['phoneme:l', 'phoneme:n']);
    expect(parsed.data.contrasts).toEqual(['s']);
    expect(parsed.data.words).toBeUndefined();
    expect(parsed.content.trim()).toBe(BODY);
  });

  it('讲词的笔记写 words，不写 triggers', () => {
    const deps = fixture();
    const r = saveAiNote(deps, draft({ title: 'machine 的 -ine', scope: 'word', values: ['Machine'], contrasts: [] }));
    const parsed = matter(readFileSync(join(deps.localNotes, `${r.id}.md`), 'utf8'));
    expect(parsed.data.words).toEqual(['machine']);
    expect(parsed.data.triggers).toBeUndefined();
  });

  it('id 撞上已有笔记时自动加后缀，不覆盖', () => {
    const deps = fixture({ id: 'ai-phoneme-l-n', title: '旧的 l/n', triggers: ['phoneme:l'] });
    const before = readFileSync(join(deps.shipped, 'ai-phoneme-l-n.md'), 'utf8');
    const r = saveAiNote(deps, draft());
    expect(r.id).toBe('ai-phoneme-l-n-2');
    expect(readFileSync(join(deps.shipped, 'ai-phoneme-l-n.md'), 'utf8')).toBe(before);
  });

  it('缺「自检法」「对比训练」时拒绝，不落文件', () => {
    const deps = fixture();
    expect(() => saveAiNote(deps, draft({ body: '## 发音原理\n舌尖顶住。' }))).toThrow(/没通过校验/);
    expect(readdirSync(deps.localNotes)).toEqual([]);
  });

  it('形近字符写错（ASCII g）时拒绝', () => {
    const deps = fixture();
    expect(() => saveAiNote(deps, draft({ values: ['g'] }))).toThrow(/phoneme:g/);
    expect(readdirSync(deps.localNotes)).toEqual([]);
  });

  it('正文对读者作实测断言时拒绝', () => {
    const deps = fixture();
    expect(() => saveAiNote(deps, draft({ body: `${BODY}\n\n你犯过 3 次。` }))).toThrow(/没通过校验/);
  });

  it('写入后同步发音档案', () => {
    const deps = fixture();
    saveAiNote(deps, draft());
    expect(readFileSync(deps.profileFile, 'utf8')).toContain('AUTO:发音统计');
  });
});
