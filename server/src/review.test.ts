import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardNotFoundError, nextState, ReviewStore, type Grade } from './review.js';

describe('nextState ladder', () => {
  // [当前rung, 已连对几次, 评价, 期望rung, 期望due(相对2026-07-28)]
  const cases: [number, number, Grade, number, string][] = [
    // **连对两次才升档**：只对一次留在原档再练一遍
    [0, 0, 'remembered', 0, '2026-07-29'],  // 第一次对 → 还在 0 档 → +1
    [0, 1, 'remembered', 1, '2026-07-30'],  // 连对第二次 → 升到 1 档 → +2
    [1, 1, 'remembered', 2, '2026-07-31'],  // → +3
    [3, 1, 'remembered', 4, '2026-08-04'],  // 顶格 → +7（上限就是一周）
    [4, 1, 'remembered', 4, '2026-08-04'],  // 已在顶格，停在那儿
    [3, 0, 'forgot', 0, '2026-07-29'],      // 重置 → +1
    [0, 0, 'forgot', 0, '2026-07-29'],      // 已在底层，重置也还是 0
  ];
  it.each(cases)('rung %i streak %i + %s → rung %i due %s', (rung, streak, grade, expRung, expDue) => {
    const next = nextState({ rung, streak, due: '2026-07-28', lastReviewed: null }, grade, '2026-07-28');
    expect(next.rung).toBe(expRung);
    expect(next.due).toBe(expDue);
    expect(next.lastReviewed).toBe('2026-07-28');
  });

  it('答错把连胜清零——不能留着上次那一半', () => {
    expect(nextState({ rung: 2, streak: 1, due: '2026-07-28', lastReviewed: null }, 'forgot', '2026-07-28').streak).toBe(0);
  });

  it('升档之后连胜从头攒，不是攒到 3、4 一路冲顶', () => {
    const next = nextState({ rung: 0, streak: 1, due: '2026-07-28', lastReviewed: null }, 'remembered', '2026-07-28');
    expect(next.rung).toBe(1);
    expect(next.streak).toBe(0);
  });
});

describe('ReviewStore', () => {
  function freshStore() {
    return new ReviewStore(join(mkdtempSync(join(tmpdir(), 'rev-')), 'review-state.json'));
  }

  it('addCard → due next day; idempotent', () => {
    const s = freshStore();
    s.addCard('click', '2026-07-28');
    s.addCard('click', '2026-07-28');
    expect(s.due('2026-07-29')).toEqual([{ text: 'click', due: '2026-07-29', starred: false }]);
    expect(s.due('2026-07-28')).toEqual([]); // 次日才到期
  });

  it('grade advances and persists across reload', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rev-')), 'review-state.json');
    const s = new ReviewStore(file);
    s.addCard('click', '2026-07-28');
    s.grade('click', 'remembered', '2026-07-29');
    const reloaded = new ReviewStore(file);
    expect(reloaded.due('2026-08-01')).toHaveLength(1); // 7-29 + 3 天 = 8-01 到期
  });

  it('removeCard deletes state', () => {
    const s = freshStore();
    s.addCard('click', '2026-07-28');
    s.removeCard('click');
    expect(s.due('2026-12-31')).toEqual([]);
  });

  // 回归：state 是普通对象，带 Object.prototype。用 `if (this.state[text])` 做存在性判断
  // 会被原型链上的属性骗到，而 "constructor" 是个真实英文词（CMUdict 里有）。曾经的表现是
  // 这个词永远建不上卡片（静默漏掉），grade 还会把 Object 构造函数当 CardState 读，往
  // review-state.json 里写 rung:NaN / due:"Invalid Date"。
  it('handles words that collide with Object.prototype keys', () => {
    const s = freshStore();
    s.addCard('constructor', '2026-07-28');
    expect(s.due('2026-07-29')).toEqual([{ text: 'constructor', due: '2026-07-29', starred: false }]);

    // 连对两次才升档
    expect(s.grade('constructor', 'remembered', '2026-07-29')!.rung).toBe(0);
    const next = s.grade('constructor', 'remembered', '2026-07-30')!;
    expect(next.rung).toBe(1);
    expect(next.due).toBe('2026-08-01');

    s.removeCard('constructor');
    expect(s.due('2026-12-31')).toEqual([]);
  });

  it('still throws CardNotFoundError for a prototype key that was never added', () => {
    const s = freshStore();
    expect(() => s.grade('constructor', 'remembered', '2026-07-29')).toThrow(CardNotFoundError);
  });

  // 回归：读侧（state[text] 命中原型链）和写侧（state['__proto__'] = x 走 __proto__ setter，
  // 根本不生成自有属性）是同一个原型问题的两面。state 换成 Object.create(null) 之后，
  // '__proto__' 只是个普通键，两侧都正常。
  it('handles __proto__ as an ordinary card key on both read and write', () => {
    const s = freshStore();
    s.addCard('hello', '2026-07-28');
    s.addCard('__proto__', '2026-07-28');
    expect(s.due('2026-07-29').map((c) => c.text).sort()).toEqual(['__proto__', 'hello']);

    expect(s.grade('__proto__', 'remembered', '2026-07-29')!.rung).toBe(0);   // 连对两次才升
    expect(s.grade('__proto__', 'remembered', '2026-07-30')!.rung).toBe(1);
    s.removeCard('__proto__');
    expect(s.due('2026-12-31').map((c) => c.text)).toEqual(['hello']);
  });

  // 下面这些必须从「磁盘上已有文件」这条路进：生产环境的 review-state.json 是 git 跟踪的、
  // 永远存在，所以每个真实 ReviewStore 走的都是构造函数里读文件那一支。只用 freshStore()
  // （磁盘无文件）测原型键，等于把唯一真正生效的那条分支整个跳过——把构造函数改回裸的
  // JSON.parse、不做 Object.create(null) 归一化，那样的测试照样全绿。
  function storeWith(state: unknown): ReviewStore {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify(state), 'utf8');
    return new ReviewStore(file);
  }

  it('keeps prototype-named keys usable when loaded from an existing file', () => {
    const s = storeWith({
      constructor: { rung: 2, due: '2026-07-20', lastReviewed: '2026-07-13' },
      // 必须用计算属性名：对象字面量里写成 `__proto__: {...}` 是设置原型的特殊语法，
      // 不会生成同名的自有属性，JSON.stringify 出来会是空的，这个键根本进不了文件。
      // （JSON.parse 反过来没有这个特殊行为，解析出来就是普通自有属性——正是生产环境的路径。）
      ['__proto__']: { rung: 0, due: '2026-07-21', lastReviewed: null },
      click: { rung: 1, due: '2026-07-25', lastReviewed: '2026-07-22' },
    });
    expect(s.due('2026-07-29').map((c) => c.text).sort()).toEqual(['__proto__', 'click', 'constructor']);
    expect(s.grade('constructor', 'remembered', '2026-07-29')!.rung).toBe(2);   // 连对两次才升
    expect(s.grade('constructor', 'remembered', '2026-07-30')!.rung).toBe(3);
    // addCard 不能把文件里已有的卡片当成"不存在"重建，那会把进度抹平
    s.addCard('constructor', '2026-07-29');
    expect(s.due('2026-12-31').find((c) => c.text === 'constructor')!.due).not.toBe('2026-07-30');
  });

  // 最贴近生产的一条：review-state.json 已经存在（git 跟踪，永远存在），然后用户新问了一个
  // 跟 Object.prototype 属性同名的词。构造函数若不做 Object.create(null) 归一化，state 就带着
  // 原型，addCard 里的 state['constructor'] 命中原型上的构造函数（真值）→ 直接 return，
  // 这个词永远建不上卡片。freshStore()（磁盘无文件）走不到这条分支，测不出来。
  it('creates a card for a prototype-named word added to an existing file', () => {
    const s = storeWith({ click: { rung: 1, due: '2026-07-25', lastReviewed: '2026-07-22' } });
    s.addCard('constructor', '2026-07-29');
    expect(s.due('2026-07-30').map((c) => c.text).sort()).toEqual(['click', 'constructor']);
  });

  // 加载时逐条验形，验不过的丢弃并告警。不丢的话：null 会让 due() 里 s.due 抛 TypeError，
  // 整个复习页 500，而且用户不重新 POST 那个词就永远好不了；真值畸形（{}）更阴——addCard
  // 认为"已存在"不修，grade() 算出 rung:NaN / due:"Invalid Date" 存回去，那张卡从此在
  // due() 里彻底消失，静默无告警。
  it.each([
    ['null', { click: null }],
    ['truthy-but-malformed', { click: {} }],
    ['string', { click: '2026-07-29' }],
    ['rung out of range', { click: { rung: 99, due: '2026-07-29', lastReviewed: null } }],
    ['non-date due', { click: { rung: 0, due: 'Invalid Date', lastReviewed: null } }],
  ])('drops a %s entry at load and keeps due() working', (_label, bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = storeWith({ ...bad, ok: { rung: 0, due: '2026-07-29', lastReviewed: null } });
      expect(s.due('2026-07-29')).toEqual([{ text: 'ok', due: '2026-07-29', starred: false }]);
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('格式不对'))).toBe(true);
      // 丢掉之后这个词就是"没有卡片"，重新 POST 能正常建卡
      s.addCard('click', '2026-07-29');
      expect(s.due('2026-07-30').map((c) => c.text).sort()).toEqual(['click', 'ok']);
    } finally {
      warn.mockRestore();
    }
  });

  // 加载器必须是**非破坏性**的：校验不过的记录只是不进内存，绝不能从磁盘上抹掉。
  // 以前是把整个内存 state 覆盖写回文件，于是"忽略"等于"删除"——那条记录的 rung 和
  // lastReviewed 一起蒸发，而这是除 notes/ 外唯一不可再生的数据。
  it('leaves rejected records untouched on disk', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({
      good: { rung: 3, due: '2026-08-10', lastReviewed: null },
      torn: { rung: 2, due: '2026-8-3' },
    }), 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new ReviewStore(file);
      s.addCard('newword', '2026-07-29');            // 触发一次写盘
      const after = JSON.parse(readFileSync(file, 'utf8'));
      expect(after.torn).toEqual({ rung: 2, due: '2026-8-3' });   // 原样保留
      expect(after.newword).toBeDefined();
      expect(after.good).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  // 服务运行期间用户手工改了别的词，不能被构造时读到的旧快照覆盖。
  it('does not clobber external edits made while running', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    // a 带 streak:1，这样下面那次答对**真的**会升档——不然它停在原档，
    // 「写盘确实发生过」这半边就证不出来了（连对两次才升）。
    writeFileSync(file, JSON.stringify({ a: { rung: 1, streak: 1, due: '2026-08-01', lastReviewed: null } }), 'utf8');
    const s = new ReviewStore(file);
    writeFileSync(file, JSON.stringify({
      a: { rung: 1, streak: 1, due: '2026-08-01', lastReviewed: null },
      manual: { rung: 4, due: '2026-09-01', lastReviewed: '2026-08-02' },
    }), 'utf8');
    s.grade('a', 'remembered', '2026-07-29');
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.manual).toBeDefined();
    expect(after.a.rung).toBe(2);
  });

  it('accepts a hand-written card that omits lastReviewed', () => {
    const s = storeWith({ hand: { rung: 0, due: '2026-08-01' } });
    expect(s.due('2026-08-05').map((c) => c.text)).toEqual(['hand']);
  });

  // 形状正则挡不住日历上不存在的日期，而 due() 是按字符串比大小的："2026-13-01" 比任何
  // 真实日期都大，那张卡再也不会到期——正是验形本该防住的静默消失。
  it.each([['2026-13-01'], ['2026-02-30'], ['2026-00-10']])('rejects the impossible date %s', (bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = storeWith({ x: { rung: 0, due: bad, lastReviewed: null } });
      // 探"有没有被加载进来"要用 grade()，不能用 due()：像 "2026-13-01" 这种字典序比任何
      // 真实日期都大的坏值，就算被加载了也不会出现在 due() 里——那样断言会因为错误的理由
      // 变绿，把"没验日历"这个 bug 放过去（本文件上一版就是这么写的，变异测试才发现）。
      expect(() => s.grade('x', 'remembered', '2026-07-29')).toThrow(CardNotFoundError);
    } finally {
      warn.mockRestore();
    }
  });

  it('backs up an unreadable file exactly once, not once per write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-'));
    const file = join(dir, 'review-state.json');
    writeFileSync(file, '{"a": {"rung": 0, "due": "2026-08-0', 'utf8');   // 截断
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new ReviewStore(file);
      s.addCard('x', '2026-07-29');
      s.addCard('y', '2026-07-29');
      expect(readdirSync(dir).filter((n) => n.includes('.corrupt-'))).toHaveLength(1);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('x');   // 写入未被损坏文件挡住
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves no .tmp behind after a successful write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-'));
    const file = join(dir, 'review-state.json');
    new ReviewStore(file).addCard('x', '2026-07-29');
    expect(readdirSync(dir)).toEqual(['review-state.json']);
  });

  // 文件在运行期间被删掉/改名之后再写入：readRaw 曾把"文件不存在"当成"读到一份空状态"，
  // 于是那次写入只落下当前这一个键，内存里其余卡片被一并抹出磁盘。
  // 文件被 git checkout / stash 还原成 {}（这文件是 git 跟踪的），或被外部截断。它是**存在
  // 且能解析**的，所以走不到"损坏"分支——只取磁盘那一份的话，下一次评分会把其余卡片全部
  // 抹掉，而且悄无声息。
  it('restores cards missing from disk after an external reset', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({
      // 刻意不用 rung 4：顶级答对会毕业出列，那是另一条规则，会盖掉这里要验的"补回"
      a: { rung: 1, due: '2026-09-01', lastReviewed: null },
      b: { rung: 3, due: '2026-09-02', lastReviewed: null },
    }), 'utf8');
    const s = new ReviewStore(file);
    writeFileSync(file, '{}', 'utf8');                      // git checkout .
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      s.grade('a', 'remembered', '2026-07-29');
      const after = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.keys(after).sort()).toEqual(['a', 'b']);
      expect(after.b.rung).toBe(3);
      expect(warn.mock.calls.map((c) => String(c[0])).some((m) => m.includes('已按内存补回'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // 读文件失败（EBUSY/EACCES——Windows 上杀软扫描抓句柄很常见）不是"损坏"。当成损坏处理
  // 会走进"备份 + 用内存覆盖"，几毫秒后锁一放，整份历史就被内存快照顶掉了。宁可这次写入
  // 失败（调用方 500、可重试），也不能拿内存去覆盖一份其实完好的文件。
  it('fails the write instead of overwriting when the file cannot be read', () => {
    // 用"路径是个目录"制造一个真实的 I/O 失败（EISDIR）。mock 掉 fs 的具名导出对
    // review.ts 无效——ESM 的具名导入在模块加载时就绑定好了。
    const dir = mkdtempSync(join(tmpdir(), 'rv-'));
    const asDir = join(dir, 'review-state.json');
    mkdirSync(asDir);
    // 构造必须不抛：ReviewStore 是在服务启动时建的，构造抛出去 = 服务根本起不来。
    let s!: ReviewStore;
    expect(() => { s = new ReviewStore(asDir); }).not.toThrow();

    // 抛出来的必须是**读**失败本身（EISDIR），而不是"当成损坏后备份失败"之类的下游错误。
    // 只断言 toThrow() 是不够的：把 `if (ioError) throw ioError` 删掉，流程会继续走到备份
    // 那步、在那里抛 EPERM，一个宽松的 toThrow() 照样绿。
    expect(() => s.addCard('b', '2026-07-29')).toThrow(/EISDIR/);
    // 也没有把它当"损坏"去做破坏性处理：目录还在，没生成 .corrupt- 备份
    expect(existsSync(asDir)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });

  it('rebuilds from memory when the file disappears at runtime', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({
      // 刻意不用 rung 4：顶级答对会毕业出列，那是另一条规则，会盖掉这里要验的"补回"
      a: { rung: 1, due: '2026-09-01', lastReviewed: null },
      b: { rung: 3, due: '2026-09-02', lastReviewed: null },
    }), 'utf8');
    const s = new ReviewStore(file);
    rmSync(file);
    s.grade('a', 'remembered', '2026-07-29');
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['a', 'b']);
  });

  // backedUp 只该给"同一次损坏"去重。做成整个进程一次性的闸门，第二次损坏（比如用户手工
  // 编辑留下语法错误，同时还加了新卡）就不会再备份，那份内容直接被内存快照覆盖掉。
  //
  // **时钟必须冻住。** 备份名是 `.corrupt-<Date.now()>`，两次损坏落进同一毫秒就会同名，
  // 而 copyFileSync 覆盖写——第二份把第一份盖掉，这条断言就该红。原来不冻时钟，
  // 两次调用之间隔多久全看机器：本机慢，一直是绿的；CI 上只有 ubuntu × node 24
  // 那一格够快，撞进同一毫秒才红了一次。**一条只在最快的机器上才生效的断言，
  // 等于把这个 bug 放跑了。** 冻住之后碰撞必然发生，哪台机器都拦得住。
  it('backs up again when the file is corrupted a second time in the same process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-'));
    const file = join(dir, 'review-state.json');
    writeFileSync(file, '{"a": {"rung": 0, "due": "2026-08-01', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'));
    try {
      const s = new ReviewStore(file);
      s.addCard('x', '2026-07-29');                       // 修好
      writeFileSync(file, '{"x":{"rung":0,"due":"2026-07-30","lastReviewed":null},', 'utf8');  // 再坏
      s.addCard('y', '2026-07-29');
      const baks = readdirSync(dir).filter((n) => n.includes('.corrupt-')).sort();
      expect(baks).toHaveLength(2);
      // 光数文件个数不够：同名覆盖时也可能因为别的原因凑够两个。两份内容必须不同。
      expect(readFileSync(join(dir, baks[0]), 'utf8')).not.toBe(readFileSync(join(dir, baks[1]), 'utf8'));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  // 内存不能跑到磁盘前面：写盘失败后如果内存已经改了，调用方重试时 addCard 会因为"内存里
  // 已经有了"直接 return，于是永远不再尝试写入，而 due() 照样报出这张根本没落盘的卡片。
  it('does not update memory when the write fails, so a retry still tries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-'));
    const s = new ReviewStore(join(dir, 'nope', 'review-state.json'));   // 父目录不存在
    expect(() => s.addCard('w', '2026-07-29')).toThrow();
    expect(s.due('2026-12-01')).toEqual([]);
    expect(() => s.addCard('w', '2026-07-29')).toThrow();               // 仍在真的尝试
  });

  // 写入以磁盘为准（persist 每次重读），存在性判断却只看内存的话两边会分叉：服务运行期间
  // 磁盘上多出一张攒了几个月的卡，再讲一次这个词就会被打回 rung 0。
  // grade 必须跟 addCard 用同一个事实来源（磁盘）。只有 addCard 查磁盘、grade 仍按内存
  // 旧 rung 算的话，用户运行期间手工改过的那张卡会被按旧值重算写回，改动无声消失。
  it('grades from the on-disk value, not a stale memory snapshot', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({ climb: { rung: 0, due: '2026-07-29', lastReviewed: null } }), 'utf8');
    const s = new ReviewStore(file);
    writeFileSync(file, JSON.stringify({ climb: { rung: 2, streak: 1, due: '2026-12-01', lastReviewed: '2026-11-01' } }), 'utf8');
    // 磁盘上是 rung 2 且已连对一次，再答对 → 升到 3；
    // 照内存里那份陈旧的（rung 0、没连胜）算的话会停在 0，两个值分得开。
    // 不用顶格 4：顶格答对会毕业出列，那是另一条规则，会把要证的事搅进来。
    expect(s.grade('climb', 'remembered', '2026-07-29')!.rung).toBe(3);
  });

  // setStarred 有同一条不变量，而且它更容易被当成"只是加个标记"：它把整张卡
  // ({...cur, starred}) 写回去，基准取错就把 rung/due/lastReviewed 一起改了——
  // 点一下星星，一张攒了两个月的卡悄悄退回起点。API 层那几条测不到这里：
  // 那条路上内存和磁盘始终一致，分叉根本没发生。
  it('stars from the on-disk value, not a stale memory snapshot', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({ climb: { rung: 0, due: '2026-07-29', lastReviewed: null } }), 'utf8');
    const s = new ReviewStore(file);
    writeFileSync(file, JSON.stringify({ climb: { rung: 4, due: '2026-12-01', lastReviewed: '2026-11-01' } }), 'utf8');
    // 标星只该改 starred，其余三个字段都得是磁盘上那份
    expect(s.setStarred('climb', true)).toEqual({
      rung: 4, due: '2026-12-01', lastReviewed: '2026-11-01', starred: true,
    });
    // 而且要真的落盘——只改内存的话下次启动又回到 0
    expect(JSON.parse(readFileSync(file, 'utf8')).climb).toEqual({
      rung: 4, due: '2026-12-01', lastReviewed: '2026-11-01', starred: true,
    });
  });

  it('does not reset an on-disk card that appeared while running', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({ other: { rung: 0, due: '2026-08-01', lastReviewed: null } }), 'utf8');
    const s = new ReviewStore(file);
    writeFileSync(file, JSON.stringify({
      other: { rung: 0, due: '2026-08-01', lastReviewed: null },
      climb: { rung: 4, due: '2026-12-01', lastReviewed: '2026-11-01' },
    }), 'utf8');
    s.addCard('climb', '2026-07-29');
    expect(JSON.parse(readFileSync(file, 'utf8')).climb.rung).toBe(4);
  });

  // 但畸形记录不能把这个词永久锁死——重新讲一次必须能建出新卡，否则用户没有任何修复手段。
  it('still creates a card when the on-disk record is malformed', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({ torn: { rung: 4, due: '2026-8-3' } }), 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new ReviewStore(file);
      s.addCard('torn', '2026-07-29');
      expect(s.due('2026-07-30').map((c) => c.text)).toContain('torn');
    } finally {
      warn.mockRestore();
    }
  });

  it('starts empty when the file parses to a non-object, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(storeWith([1, 2, 3]).due('2026-12-31')).toEqual([]);
      // 这条告警是"整份复习进度被丢弃"的唯一信号，必须钉住——只 mock 掉不断言的话，
      // 把 sanitize 里的顶层 warn 删掉测试照样绿。
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => m.includes('不是合法 JSON 对象'))).toBe(true);
      expect(msgs.some((m) => m.includes('已备份到'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 收藏状态得**读得回来**。
 *
 * isCardState 一直是认 starred 的，但载入内存那一步只拷了 rung/due/lastReviewed，
 * 把它漏掉了。而 due() 和 cardOf() 读的都是内存——于是磁盘上还是 true、
 * 界面上每次重启就变回没收藏。实测过：PUT 加星后 due 报 true，
 * 重启服务后同一张卡报 false，而磁盘一直是 true。
 */
describe('连胜要能从磁盘读回来', () => {
  // grade() 的基准取自 cardOnDisk()，而它一度也在手挑字段、把 streak 漏了——
  // 于是每次都从 undefined 重新数，卡片永远升不了档。两次漏字段（load 漏 starred、
  // cardOnDisk 漏 streak）现在收进同一个 toCard()。
  it('答对一次落盘，再答对一次就升档——中间隔着一次读盘', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    const s = new ReviewStore(file);
    s.addCard('climb', '2026-07-28');
    expect(s.grade('climb', 'remembered', '2026-07-29')!.rung).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).climb.streak, '连胜没落盘').toBe(1);
    // 换一个 store ＝ 重启服务；连胜得读得回来，这一次才升得了档
    expect(new ReviewStore(file).grade('climb', 'remembered', '2026-07-30')!.rung).toBe(1);
  });
});

describe('收藏状态跨重启还在', () => {
  function storeWith(card: object) {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    writeFileSync(file, JSON.stringify({ climb: card }), 'utf8');
    return new ReviewStore(file);   // 重开一个 store ＝ 重启服务
  }

  it('due() 报得出收藏', () => {
    const s = storeWith({ rung: 0, due: '2026-07-29', lastReviewed: null, starred: true });
    expect(s.due('2026-07-29')[0]?.starred, '重启后收藏没了').toBe(true);
  });

  it('cardOf() 也报得出', () => {
    const s = storeWith({ rung: 0, due: '2026-07-29', lastReviewed: null, starred: true });
    expect(s.cardOf('climb')?.starred, '重启后收藏没了').toBe(true);
  });

  it('没收藏的还是没收藏——别反过来一律当成收藏', () => {
    const s = storeWith({ rung: 0, due: '2026-07-29', lastReviewed: null });
    expect(s.due('2026-07-29')[0]?.starred).toBe(false);
    expect(s.cardOf('climb')?.starred ?? false).toBe(false);
  });
});

/**
 * 把备份里的复习进度并进来。
 *
 * ── 这一段为什么值得单独测 ──
 *
 * `merge` **一条测试都没有**（`/api/backup` 那七条一次都没碰复习状态），
 * 而 CLAUDE.md 明写着它的三条语义之一是「复习进度本机那张赢」。
 * 读一遍就看出两处：字段是手挑的（streak 并不过来）、校验比 isCardState 松
 * （rung=99 能写进去，下次启动加载时反被判废丢掉）。
 *
 * 手挑字段这件事这个文件里已经踩过两次——load 漏 starred、cardOnDisk 漏 streak。
 * 这是第三处。
 */
describe('merge：把备份的进度并进来', () => {
  function store() {
    return new ReviewStore(join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json'));
  }
  const CARD = { rung: 2, due: '2026-09-01', lastReviewed: '2026-08-20', starred: true, streak: 1 };

  it('本机没有的 → 并进来，返回并入几张', () => {
    const s = store();
    expect(s.merge({ climb: CARD })).toBe(1);
    expect(s.cardOf('climb')).toMatchObject({ rung: 2, due: '2026-09-01' });
  });

  // 典型场景是"换了台电脑想合起来"，而本机的进度是你刚练出来的，
  // 导入一份旧备份不该把它推回去。
  it('本机已有的 → 本机那张赢，一个字段都不动', () => {
    const s = store();
    s.addCard('climb', '2026-07-28');
    const before = s.cardOf('climb');
    expect(s.merge({ climb: CARD })).toBe(0);
    expect(s.cardOf('climb'), '本机的进度被备份覆盖了').toEqual(before);
  });

  it('starred 和 streak 都要一起并过来——手挑字段漏过两次了', () => {
    const s = store();
    s.merge({ climb: CARD });
    expect(s.cardOf('climb')?.starred, 'starred 没并过来').toBe(true);
    expect(s.cardOf('climb')?.streak, 'streak 没并过来——连胜会从 0 重新数').toBe(1);
  });

  // 校验必须跟加载那一套一致。松了的话能并进来一张下次启动就消失的卡。
  it.each([
    ['rung 超出阶梯范围', { rung: 99, due: '2026-09-01' }],
    ['due 不是真日期', { rung: 0, due: '2026-13-45' }],
    ['due 根本不是日期形状', { rung: 0, due: '明天' }],
    ['缺 rung', { due: '2026-09-01' }],
    ['压根不是对象', 'nope'],
  ])('%s → 跳过，不并', (_label, card) => {
    const s = store();
    expect(s.merge({ climb: card })).toBe(0);
    expect(s.cardOf('climb')).toBeUndefined();
  });

  it('并进来的要落盘——不然重启就没了', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    new ReviewStore(file).merge({ climb: CARD });
    // ReviewStore 的构造函数就读盘（跟 NoteStore 不一样，那个要显式 load()）
    const reopened = new ReviewStore(file);
    expect(reopened.cardOf('climb')?.streak, '落盘或读回丢了 streak').toBe(1);
  });

  it('传进来不是对象 → 返回 0，不抛', () => {
    const s = store();
    expect(s.merge(null)).toBe(0);
    expect(s.merge('x')).toBe(0);
    expect(s.merge(undefined)).toBe(0);
  });
});

/**
 * 导入备份不该打「磁盘上缺少…」那句告警。
 *
 * persist 里那句是给真事故留的（文件被 git checkout 还原、被截断、被删）。
 * 而 merge 原来**先写内存再落盘**，于是每并一张卡都会误触发它一次——
 * 实测全新机器导入 30 张卡的备份，会打 30 句「磁盘上缺少 1 张服务已知的卡片…
 * 若你是有意手工删卡，请在服务停止时操作」。什么都没缺，全是顺序反了造成的。
 *
 * 改成跟 addCard / grade 同一个顺序：先落盘、成功了再改内存。
 */
describe('merge 不许误报「磁盘上缺少」', () => {
  it('全新机器上导入一份备份，一句告警都不该有', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'review-state.json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new ReviewStore(file);
      const n = s.merge({
        climb: { rung: 2, due: '2026-09-01' },
        other: { rung: 0, due: '2026-09-02' },
        third: { rung: 1, due: '2026-09-03' },
      });
      expect(n, '前提：三张都并进来了').toBe(3);
      const noisy = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('磁盘上缺少'));
      expect(noisy, `导一份备份打了 ${noisy.length} 句「磁盘上缺少」`).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
