import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chokidar from 'chokidar';
import { NoteStore, validateTriggers, type Note } from './notes.js';

const NOTE = `---
id: test-note
title: 测试笔记
triggers: [phoneme:l, clear-l]
severity: confirmed
---

正文内容。
`;

describe('NoteStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'notes-')); });

  it('loads note with frontmatter', () => {
    writeFileSync(join(dir, 'a.md'), NOTE, 'utf8');
    const store = new NoteStore(dir);
    store.load();
    const n = store.get('test-note')!;
    expect(n.title).toBe('测试笔记');
    expect(n.triggers).toEqual(['phoneme:l', 'clear-l']);
    // **NoteStore 一律给 info。** frontmatter 里写什么都不读——
    // severity 是"这是不是**你的**短板"，而那要看使用者自己的评测记录
    // （profile.ts 的 severityOf 在服务这一层换档）。笔记不该替读者回答这个问题：
    // 别人克隆这个仓库，看到的会是前一个使用者的判定。
    expect(n.severity).toBe('info');
    expect(n.markdown).toContain('正文内容');
    expect(n.markdown).not.toContain('---');
  });

  it('skips file without valid frontmatter', () => {
    writeFileSync(join(dir, 'bad.md'), '# 没有 frontmatter\n', 'utf8');
    const store = new NoteStore(dir);
    store.load();
    expect(store.all()).toHaveLength(0);
  });

  it('defaults severity to info when invalid', () => {
    writeFileSync(join(dir, 'b.md'), NOTE.replace('confirmed', 'bogus'), 'utf8');
    const store = new NoteStore(dir);
    store.load();
    expect(store.get('test-note')!.severity).toBe('info');
  });

  it('load() keeps a note whose trigger fails validation (warns, does not skip)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(dir, 'c.md'), NOTE.replace('triggers: [phoneme:l, clear-l]', 'triggers: [phoneme:zzz]'), 'utf8');
    const store = new NoteStore(dir);
    store.load();
    expect(store.get('test-note')).toBeDefined();
    expect(store.all()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('watch() only attaches one chokidar watcher across repeated calls', () => {
    const watchSpy = vi.spyOn(chokidar, 'watch').mockReturnValue({ on: () => ({}) } as unknown as ReturnType<typeof chokidar.watch>);
    const store = new NoteStore(dir);
    store.watch();
    store.watch();
    store.watch();
    expect(watchSpy).toHaveBeenCalledTimes(1);
    watchSpy.mockRestore();
  });
  // 回归：两篇笔记声明同一个 id 时，笔记按 id 存进 Map，后读到的会顶掉前一篇。以前是
  // 完全静默的——文件还在 notes/ 里，但既不出现在笔记页也匹配不上任何词。照着已有笔记
  // 复制模板、忘了改 id 是很自然的操作，必须告警，而且必须点名到底哪个文件生效。
  it('warns when two notes declare the same id, naming which file actually won', () => {
    // 两篇同 id 的笔记内容必须可区分，否则测试根本验证不了"谁赢了"——赢家只体现在
    // note.file 上，标题/正文一样的话，改成 first-wins 这个测试照样绿。
    const dup = (marker: string) =>
      `---
id: dup
title: T-${marker}
triggers: [phoneme:l]
severity: info
---

${marker} 的正文
`;
    writeFileSync(join(dir, 'a.md'), dup('a'), 'utf8');
    writeFileSync(join(dir, 'b.md'), dup('b'), 'utf8');
    writeFileSync(join(dir, 'c.md'), `---
id: uniq
title: U
triggers: [phoneme:n]
severity: info
---

正文
`, 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new NoteStore(dir);
      store.load();

      expect(store.all().map((n) => n.id).sort()).toEqual(['dup', 'uniq']);

      // readdirSync 不保证顺序（ext4 dir_index 是哈希序），所以不写死谁赢——只断言
      // 「告警里点名的生效文件」跟「实际留在 store 里的那一份」是同一个。
      const survivor = store.get('dup')!;
      expect(['a.md', 'b.md']).toContain(survivor.file);
      expect(survivor.title).toBe(`T-${survivor.file[0]}`);

      const conflict = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('id 冲突'));
      expect(conflict).toHaveLength(1);
      // 冲突的 id 本身必须出现在告警里——那是用户唯一需要动手改的字段。之前这条断言被
      // 漏掉了，把 `id "${id}" 被…声明` 整段从消息里删掉测试也照样绿。
      expect(conflict[0]).toContain('"dup"');
      expect(conflict[0]).toContain(`当前生效的是 "${survivor.file}"`);
      const loser = survivor.file === 'a.md' ? 'b.md' : 'a.md';
      expect(conflict[0]).toContain(`"${loser}" 会被完全忽略`);
    } finally {
      warn.mockRestore();
    }
  });

  // 三篇以上同 id 时，边扫边报会先报一个"生效"文件、而它随后又被下一篇顶掉——用户照着
  // 那条告警去改，改的是一份同样被忽略的副本。告警必须等整轮扫完、赢家确定之后再发，
  // 而且只发一条。
  it('names the surviving file when three notes share an id', () => {
    const dup = (marker: string) =>
      `---
id: dup
title: T-${marker}
triggers: [phoneme:l]
severity: info
---

${marker}
`;
    for (const m of ['a', 'b', 'c']) writeFileSync(join(dir, `${m}.md`), dup(m), 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new NoteStore(dir);
      store.load();
      const survivor = store.get('dup')!;

      const conflict = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('id 冲突'));
      expect(conflict).toHaveLength(1); // 一条，不是每撞一次报一条
      expect(conflict[0]).toContain('被 3 篇笔记声明');
      expect(conflict[0]).toContain(`当前生效的是 "${survivor.file}"`);

      // 断言必须落在"被忽略"那一段上，而且不能写成恒真的形式。上一版是
      //   ignoredClause = split('会被完全忽略')[0]；再断言 not.toContain('"x" 会')
      // ——"会"字已经被 split 吃掉了，那个否定断言永远成立；而赢家的文件名本来就紧跟在
      // "当前生效的是"后面、落在这一段里，正向断言也永远成立。等于什么都没测。
      // 现在改成：把两个短语之间那段单独取出来，按顿号拆成文件名集合，跟期望的输家集合
      // 做**精确相等**比对——多列一个（比如没过滤掉赢家）或少列一个都会红。
      const between = conflict[0].split('当前生效的是')[1].split('会被完全忽略')[0];
      const listed = (between.match(/"[^"]+\.md"/g) ?? []).map((x) => x.replace(/"/g, ''));
      const expectedIgnored = ['a.md', 'b.md', 'c.md'].filter((f) => f !== survivor.file);
      // between 以赢家开头（紧跟"当前生效的是"），去掉它之后剩下的应当恰好是输家集合
      expect(listed[0]).toBe(survivor.file);
      expect(listed.slice(1).sort()).toEqual(expectedIgnored.sort());
    } finally {
      warn.mockRestore();
    }
  });
});

describe('validateTriggers', () => {
  function note(overrides: Partial<Note>): Note {
    return {
      id: 'n', title: 't', triggers: [], contrasts: [], words: [], severity: 'confirmed',
      markdown: '', file: 'n.md', ...overrides,
    };
  }

  it('warns about an unemittable cluster-onset trigger and suggests the IPA (U+0261) form', () => {
    const warnings = validateTriggers([note({ id: 'kl-cluster', triggers: ['cluster-onset:gl'] })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kl-cluster');
    expect(warnings[0]).toContain('cluster-onset:ɡl'); // U+0261 script-g + l
  });

  it('has no warnings for a note with valid triggers', () => {
    const warnings = validateTriggers([
      note({ triggers: ['phoneme:l', 'cluster-onset:kl', 'dark-l', 'flap-t'] }),
    ]);
    expect(warnings).toEqual([]);
  });

  // cluster-coda 没法照 onset 那样用白名单校验（coda 是"剩下的辅音全归它"，本来就没有
  // 合法表），能查的只有"串里每个符号都是真辅音"。下面几条守的正是这一条查得住什么。
  it('accepts a real coda cluster', () => {
    expect(validateTriggers([note({ triggers: ['cluster-coda:ks', 'cluster-coda:kst'] })])).toEqual([]);
  });

  it('rejects a vowel smuggled into a coda cluster', () => {
    const w = validateTriggers([note({ id: 'bad-coda', triggers: ['cluster-coda:kæs'] })]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('cluster-coda:kæs');
  });

  it('rejects a single consonant as a coda cluster（那该写 phoneme:）', () => {
    expect(validateTriggers([note({ triggers: ['cluster-coda:k'] })])).toHaveLength(1);
  });

  it('suggests the IPA (U+0261) form for an ASCII-g coda too', () => {
    // dogs /dɔɡz/ 的词尾是 ɡz，手敲成 ASCII "gz" 的话永远匹配不上
    const w = validateTriggers([note({ id: 'coda-g', triggers: ['cluster-coda:gz'] })]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('cluster-coda:ɡz');   // U+0261
  });

  it('splits multi-char consonants longest-first（tʃ 不能被拆成 t + ʃ）', () => {
    // ntʃ 是 lunch /lʌntʃ/ 的词尾，两个辅音，合法。
    expect(validateTriggers([note({ triggers: ['cluster-coda:ntʃ'] })])).toEqual([]);

    // **这一条才是最长匹配的分水岭**：tʃ 是**一个**辅音（watch /wɑtʃ/ 的词尾就是它），
    // 所以 cluster-coda:tʃ 永远不会被产出，该写 phoneme:tʃ。
    // 逐字符拆的话它会变成 t + ʃ、长度 2、当成合法连缀放行——
    // 上面那条 ntʃ 在两种拆法下都通过，拦不住这个错法（变异测试逐条量出来的）。
    expect(validateTriggers([note({ id: 'tsh', triggers: ['cluster-coda:tʃ'] })])).toHaveLength(1);
  });

  it('flags an outright bogus trigger', () => {
    const warnings = validateTriggers([note({ id: 'bogus', triggers: ['phoneme:zzz'] })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bogus');
    expect(warnings[0]).toContain('phoneme:zzz');
  });

  it('accepts the stress-conditional analyzer outputs ə/ɚ/ɝ/ʌ that parsePhones() produces but ' +
     'the static IPA table alone does not list, and still rejects a genuinely impossible phoneme', () => {
    const warnings = validateTriggers([
      note({ triggers: ['phoneme:ə', 'phoneme:ɚ', 'phoneme:ɝ', 'phoneme:ʌ'] }),
    ]);
    expect(warnings).toEqual([]);

    const bogus = validateTriggers([note({ id: 'zzz-note', triggers: ['phoneme:zzz'] })]);
    expect(bogus).toHaveLength(1);
    expect(bogus[0]).toContain('phoneme:zzz');
  });
});

describe('watch 的重扫回调', () => {
  // 跟上面那条一样 mock 掉 chokidar：起真 watcher 既慢又会泄漏（NoteStore 没有 close），
  // 而这里要验的是"'all' 事件触发时都做了什么"，把处理器抓出来直接调即可。
  function captureHandler() {
    let handler: (() => void) | undefined;
    const spy = vi.spyOn(chokidar, 'watch').mockReturnValue({
      on: (_evt: string, fn: () => void) => { handler = fn; return {}; },
    } as unknown as ReturnType<typeof chokidar.watch>);
    return { get: () => handler, restore: () => spy.mockRestore() };
  }

  it('重扫之后回调被调用——发音档案靠它才不会停在旧数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'));
    writeFileSync(join(dir, 'a.md'), `---
id: a
title: A
triggers: [phoneme:n]
severity: info
---
正文
`, 'utf8');
    const store = new NoteStore(dir);
    store.load();

    const cap = captureHandler();
    let calls = 0;
    store.watch(() => { calls += 1; });

    // 新增一篇，再触发一次 'all'
    writeFileSync(join(dir, 'b.md'), `---
id: b
title: B
triggers: [phoneme:l]
severity: info
---
正文
`, 'utf8');
    cap.get()!();
    cap.restore();

    expect(store.all().map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(calls).toBe(1);
  });

  it('回调抛异常不会把服务带走', () => {
    // chokidar 的事件处理器里抛出去就是未捕获异常，整个进程会挂。
    // 同步发音档案失败绝不该有这个后果。
    const dir = mkdtempSync(join(tmpdir(), 'watch-'));
    const store = new NoteStore(dir);
    store.load();

    const cap = captureHandler();
    store.watch(() => { throw new Error('boom'); });
    expect(() => cap.get()!()).not.toThrow();
    cap.restore();
  });

  it('不传回调也能用（watch 的原有调用方式不受影响）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'watch-'));
    const store = new NoteStore(dir);
    store.load();
    const cap = captureHandler();
    store.watch();
    expect(() => cap.get()!()).not.toThrow();
    cap.restore();
  });
});

/**
 * contrasts 的校验。**理由比 triggers 那边更强**：坏 trigger 会让笔记在词条页上
 * 少出现，比较显眼；坏 contrasts 的表现是"该讲解的那一次没讲解"——安静得多，
 * 而这正是这个仓库刚栽过的坏法。
 */
describe('validateTriggers 也看 contrasts', () => {
  const note = (contrasts: string[]) => ({
    id: 'x', title: 'x', triggers: ['phoneme:θ'], contrasts,
    words: [], severity: 'info' as const, markdown: '', file: 'x.md',
  });

  it('真音素不报警', () => {
    expect(validateTriggers([note(['s', 'f'])])).toEqual([]);
  });

  it('带了 phoneme: 前缀 → 报警（contrasts 只写符号本身）', () => {
    const w = validateTriggers([note(['phoneme:s'])]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('phoneme: 前缀');
  });

  it('形近字符 → 报警并给出建议', () => {
    // ASCII g（U+0067）不是 IPA script-g（U+0261）。这个坑在 triggers 上坏过两次
    const w = validateTriggers([note(['g'])]);
    expect(w).toHaveLength(1);
    expect(w[0], '没提示该用 ɡ').toContain('ɡ');
  });

  it('根本不存在的符号 → 报警', () => {
    expect(validateTriggers([note(['zzz'])])).toHaveLength(1);
  });
});

/**
 * 位置标签的白名单只有一处（STATIC_TRIGGERS），而那条告警文案曾经把里面的名字
 * **又手抄了一遍**：「…也不是 clear-l/dark-l/flap-t」。往 Set 里加第四个标签
 * 而忘了改那句，报错信息就开始说谎——它会说 final-voiced 不合法，而它其实合法。
 * 现在文案从 Set 生成，这两条守着它。
 */
describe('位置标签的白名单和告警文案不能失步', () => {
  function note(overrides: Partial<Note>): Note {
    return {
      id: 'n', title: 't', triggers: [], contrasts: [], words: [], severity: 'info',
      markdown: '', file: 'n.md', ...overrides,
    };
  }

  it.each(['clear-l', 'dark-l', 'flap-t', 'final-voiced'])('%s 是合法 trigger，不该告警', (t) => {
    expect(validateTriggers([note({ triggers: [t] })])).toEqual([]);
  });

  it('告警文案里必须列全所有位置标签——手抄那份会过期', () => {
    const w = validateTriggers([note({ id: 'bogus', triggers: ['nonsense-tag'] })]);
    expect(w).toHaveLength(1);
    for (const t of ['clear-l', 'dark-l', 'flap-t', 'final-voiced']) {
      expect(w[0], `告警没提到 ${t}——文案跟白名单失步了`).toContain(t);
    }
  });

  /**
   * 仓库自带的这十几篇也得自己过关——`validateShape` 早有这一条
   * （notes.shape.test.ts 的「仓库里现有的笔记全部合格」），triggers 这边一直没有。
   *
   * 而这恰恰是更该守的那半：坏 trigger **不会让笔记加载失败**，它只是从此匹配不上
   * 任何词，界面上表现为「这篇笔记从来不出现」——没有报错、没有空白页。
   * 服务启动时确实会打一行告警，但那行淹在启动日志里，没人会盯。
   * 形近字符（ASCII `g` 对 IPA `ɡ`）在这个仓库真坏过两次，两次都是这么坏的。
   */
  it('仓库里现有的笔记，trigger 全都合法', () => {
    const store = new NoteStore(join(import.meta.dirname, '..', '..', 'notes'));
    // 构造函数不读盘，得显式 load()。少这一句 all() 就是空数组，
    // validateTriggers([]) 恒等于 []，这条用例永远绿——shape 那条踩过这个坑。
    store.load();
    expect(store.all().length, '一篇笔记都没读到，这条用例是空过的').toBeGreaterThanOrEqual(5);
    const w = validateTriggers(store.all());
    expect(w, `这些笔记的 trigger 有问题：${w.join(' / ')}`).toEqual([]);
  });
});
