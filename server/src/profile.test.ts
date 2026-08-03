import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, logAttempt } from './db.js';
import { NoteStore } from './notes.js';
import { syncProfile, renderBlock, BEGIN, END } from './profile.js';

const NOW = '2026-07-29T10:00:00Z';

function fixture() {
  const db = openDb(':memory:');
  const notesDir = mkdtempSync(join(tmpdir(), 'pnotes-'));
  writeFileSync(join(notesDir, 'l-vs-n.md'), `---
id: l-vs-n
title: l / n 不分
triggers: [phoneme:l, phoneme:n]
severity: confirmed
---
舌尖抵上齿龈。
`, 'utf8');
  const notes = new NoteStore(notesDir);
  notes.load();
  return { db, notes, dir: notesDir, file: join(mkdtempSync(join(tmpdir(), 'prof-')), '发音档案.md') };
}

const HAND_WRITTEN = `# 发音档案

## 基本设定

- 母语：中文（普通话）
- 目标口音：**美式发音**

## 已确认的习惯问题

### 1. l / n 不分

- **来源**：方言习惯，非生理缺陷
- **例词**：night/light
`;

function attempt(db: ReturnType<typeof openDb>, text: string, ops: Parameters<typeof logAttempt>[1]['ops'], at = NOW) {
  logAttempt(db, { entryText: text, target: text, at, targetIpa: ['n', 'aɪ', 't'], heardIpa: ['l', 'aɪ', 't'], ops,
    // 有错的那些一律不算全对；clean 现在由调用方算好传进来（见 logAttempt 的注释）
    clean: ops.every((o) => o.kind === 'match') });
}

describe('syncProfile —— 手写内容不能被吃掉', () => {
  it('第一次写：原有手写内容一字不改，统计块追加在后面', () => {
    const { db, notes, file } = fixture();
    writeFileSync(file, HAND_WRITTEN, 'utf8');
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);
    syncProfile(file, db, notes, NOW);

    const after = readFileSync(file, 'utf8');
    // 手写的每一行都还在
    for (const line of HAND_WRITTEN.split('\n').filter((l) => l.trim())) {
      expect(after).toContain(line);
    }
    expect(after).toContain('发音统计');
  });

  it('反复同步只替换标记块，手写内容不会被重复插入或截断', () => {
    const { db, notes, file } = fixture();
    writeFileSync(file, HAND_WRITTEN, 'utf8');
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);
    syncProfile(file, db, notes, NOW);
    const once = readFileSync(file, 'utf8');

    attempt(db, 'light', [{ kind: 'sub', targetIpa: 'l', heardIpa: 'n' }]);
    syncProfile(file, db, notes, NOW);
    const twice = readFileSync(file, 'utf8');

    // 标记块只有一份——写成"每次追加"的话档案会越滚越长，几十次之后没法看
    expect(twice.match(/AUTO:发音统计 开始/g)).toHaveLength(1);
    expect(twice.match(/AUTO:发音统计 结束/g)).toHaveLength(1);
    // 手写标题也只有一份
    expect(twice.match(/## 已确认的习惯问题/g)).toHaveLength(1);
    expect(twice).toContain('- **来源**：方言习惯，非生理缺陷');
    expect(twice).not.toBe(once);          // 新数据确实进去了
  });

  it('用户在标记块之后又手写了内容 → 那部分也保住', () => {
    const { db, notes, file } = fixture();
    writeFileSync(file, HAND_WRITTEN, 'utf8');
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);
    syncProfile(file, db, notes, NOW);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n\n## 待观察\n\n- 词尾 /d/ 好像有点轻\n`, 'utf8');

    attempt(db, 'need', [{ kind: 'del', targetIpa: 'd' }]);
    syncProfile(file, db, notes, NOW);

    const after = readFileSync(file, 'utf8');
    expect(after).toContain('## 待观察');
    expect(after).toContain('- 词尾 /d/ 好像有点轻');
    expect(after.match(/AUTO:发音统计 开始/g)).toHaveLength(1);
  });

  it('档案文件还不存在 → 创建它，不抛异常', () => {
    const { db, notes, file } = fixture();
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);
    expect(() => syncProfile(file, db, notes, NOW)).not.toThrow();
    expect(readFileSync(file, 'utf8')).toContain('发音统计');
  });

  /**
   * 拒绝写是对的，但**要知道这条守卫怎么伤过人**：
   *
   * 开发期把界面文案里的「听辨」统一改成「评测」时，连 AUTO 标记里的措辞一起换了。
   * 于是新标记跟已有档案对不上，这条守卫检测到「开始 0 个、结束 1 个」，直接拒绝写入。
   * 守卫做对了——文件一字未动——但**统计从那一刻起静默停更**，不看服务端日志根本
   * 发现不了。当时的解法是留一张旧标记表读的时候一并认；发布前那张表删掉了
   * （模板里没有标记，新装的人不可能有旧格式），理由写在 profile.ts 的 BEGIN 上面。
   *
   * 所以：**改 BEGIN / END 的字符串，等于给所有已有用户做一次数据迁移**。
   */
  it('用户把结束标记删了 → 拒绝写入并报错，绝不猜边界', () => {
    // 这条必须用**真的** BEGIN 常量。写成简写标记 `<!-- AUTO:发音统计 开始 -->` 的话，
    // indexOf 根本匹配不上，于是走的是"文件里没有标记"那条路——危险路径从测试底下溜过去了。
    const { db, notes, file } = fixture();
    const broken = `${HAND_WRITTEN}\n${BEGIN}\n旧的残留\n\n## 我后来写的\n\n- 重要笔记\n`;
    writeFileSync(file, broken, 'utf8');
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);

    expect(() => syncProfile(file, db, notes, NOW)).toThrow(/标记/);
    // 关键：文件一个字节都没动
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });

  it('出现两个开始标记 → 同样拒绝写，不去猜哪个才算数', () => {
    const { db, notes, file } = fixture();
    const dup = `${HAND_WRITTEN}\n${BEGIN}\n## 中间的手写内容\n\n${BEGIN}\n旧统计\n${END}\n`;
    writeFileSync(file, dup, 'utf8');
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);

    expect(() => syncProfile(file, db, notes, NOW)).toThrow(/标记/);
    expect(readFileSync(file, 'utf8')).toBe(dup);
  });

  it('不留临时文件', () => {
    const { db, notes, file } = fixture();
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);
    syncProfile(file, db, notes, NOW);
    expect(readdirSync(join(file, '..')).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

describe('renderBlock 的内容', () => {
  it('没有任何记录时说清楚"还没有"，不编造统计', () => {
    const { db, notes } = fixture();
    const block = renderBlock(db, notes, NOW);
    expect(block).toContain('还没有评测记录');
    expect(block).not.toContain('|');   // 不画一张空表
  });

  it('按次数排序，最常犯的在最上面', () => {
    const { db, notes } = fixture();
    for (let i = 0; i < 3; i++) attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);
    attempt(db, 'need', [{ kind: 'del', targetIpa: 'd' }]);
    const block = renderBlock(db, notes, NOW);
    expect(block.indexOf('把 /n/ 发成了 /l/')).toBeLessThan(block.indexOf('/d/ 没发出来'));
  });

  it('有笔记的错法链到笔记，没笔记的单独列进"该补的笔记"', () => {
    const { db, notes } = fixture();
    attempt(db, 'night', [{ kind: 'sub', targetIpa: 'n', heardIpa: 'l' }]);   // l-vs-n 笔记覆盖
    // 没有笔记的那条要够门槛才会被推荐：3 次、跨两个词（见 worthANote）
    attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
    attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
    attempt(db, 'thought', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
    const block = renderBlock(db, notes, NOW);

    expect(block).toContain('[l / n 不分](notes/l-vs-n.md)');
    expect(block).toContain('### 该补的笔记');
    expect(block).toContain('把 /θ/ 发成了 /s/');
    // 已经有笔记的那条不该出现在"该补"里
    const missingSection = block.slice(block.indexOf('### 该补的笔记'));
    expect(missingSection).not.toContain('把 /n/ 发成了 /l/');
  });

  /**
   * 「该补的笔记」的两条门槛。都是被真实数据打出来的：
   *
   * 「把 /d/ 发成了 /t/」6 次，看着像普通话没有清浊对立那个经典问题，
   * 查下来 6 次**全在 dopamine 一个词上**，而 book 录了 6 次 /b/ 一次都没掉；
   * 那 6 次的转写本身也是坏的（[ħ] 一个音、t o x æ m i n——x 英语里没有）。
   * 照这个写一篇笔记，就是凭空造出一个不存在的发音问题。
   *
   * 而已知为真的「把 /l/ 发成了 /n/」出现在 click / glass / light 三个词上。
   * **跨词复现**是"这是你的发音习惯"和"这是那次录音的问题"之间最可靠的分界线。
   */
  /**
   * 给 Claude Code 的队列里**词级**的那一半。
   *
   * 音素级的「该补的笔记」回答不了这个问题：dopamine detox 练了 35 次、全对率 11%，
   * 而它已经挂着三篇讲解——不是"缺一篇笔记"，是**现有的讲解没起作用**。
   * 他自己练的时候不一定开着 AI 对话，这一节就是留给"等下次"的清单。
   */
  /**
   * 「有笔记」的判据：替换错要**两边都覆盖到**。
   *
   * 替换是关于一对音的：把 A 念成了 B。一篇只讲到其中一个的笔记教不了这个混淆。
   * 真实后果：/n/→/ŋ/ 出现 9 次、跨两个词（dopamine detox 和 thin），
   * 典型的前后鼻音不分，却被 l-vs-n 认领了——因为那篇声明了 phoneme:n，
   * 而它一个字都没提后鼻音。于是这条真问题从「该补的笔记」里消失了。
   */
  describe('替换错要两边都覆盖到才算有笔记', () => {
    it('只沾上一边 → 不算覆盖，该进"该补的笔记"', () => {
      const { db, notes } = fixture();   // l-vs-n 声明的是 phoneme:l 和 phoneme:n
      for (const w of ['thin', 'dopamine']) {
        for (let i = 0; i < 2; i++) attempt(db, w, [{ kind: 'sub', targetIpa: 'n', heardIpa: 'ŋ' }]);
      }
      const block = renderBlock(db, notes, NOW);
      const sec = block.slice(block.indexOf('### 该补的笔记'));
      expect(sec, '/n/→/ŋ/ 被 l-vs-n 冒领了').toContain('把 /n/ 发成了 /ŋ/');
    });

    it('两边都覆盖到 → 算覆盖', () => {
      const { db, notes } = fixture();
      for (const w of ['light', 'click']) {
        for (let i = 0; i < 2; i++) attempt(db, w, [{ kind: 'sub', targetIpa: 'l', heardIpa: 'n' }]);
      }
      const block = renderBlock(db, notes, NOW);
      expect(block).toContain('[l / n 不分](notes/l-vs-n.md)');
      const i = block.indexOf('### 该补的笔记');
      if (i >= 0) expect(block.slice(i)).not.toContain('把 /l/ 发成了 /n/');
    });

    it('多音也只涉及一个音素——别把"两边都要"套到它头上', () => {
      // ins 只有"听到的"那一侧，没有目标音。要求两边都覆盖的话它永远算没笔记。
      const { db, notes } = fixture();
      for (const w of ['click', 'glass']) {
        for (let i = 0; i < 2; i++) attempt(db, w, [{ kind: 'ins', heardIpa: 'n' }]);
      }
      expect(renderBlock(db, notes, NOW)).toContain('[l / n 不分](notes/l-vs-n.md)');
    });

    it('漏音只涉及一个音素，规则不变', () => {
      const { db, notes } = fixture();
      for (const w of ['thin', 'night']) {
        for (let i = 0; i < 2; i++) attempt(db, w, [{ kind: 'del', targetIpa: 'n' }]);
      }
      const block = renderBlock(db, notes, NOW);
      expect(block).toContain('[l / n 不分](notes/l-vs-n.md)');
    });
  });

  describe('卡住的词', () => {
    function clean(db: Parameters<typeof renderBlock>[0], text: string, n: number) {
      for (let i = 0; i < n; i++) logAttempt(db, {
        entryText: text, target: text, at: NOW, targetIpa: ['n'], heardIpa: ['n'],
        ops: [{ kind: 'match', targetIpa: 'n', heardIpa: 'n' }], clean: true,
      });
    }

    it('练得多、全对率低 → 列出来，并说清全对几次', () => {
      const { db, notes } = fixture();
      for (let i = 0; i < 8; i++) attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      clean(db, 'thin', 1);
      const block = renderBlock(db, notes, NOW);
      expect(block).toContain('### 卡住的词');
      expect(block).toContain('thin');
      expect(block).toMatch(/9 次/);      // 8 错 + 1 对
    });

    it('练得少的不算——三次说明不了什么', () => {
      const { db, notes } = fixture();
      for (let i = 0; i < 3; i++) attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      expect(renderBlock(db, notes, NOW)).not.toContain('### 卡住的词');
    });

    it('练得多但基本都对 → 不算卡住', () => {
      const { db, notes } = fixture();
      clean(db, 'thin', 9);
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      expect(renderBlock(db, notes, NOW)).not.toContain('### 卡住的词');
    });

    it('那一行必须带上"练了几次、全对几次"', () => {
      // 只说"这个词卡住了"没有用——卡在 11% 还是 38%，处理方式完全不同。
      const { db, notes } = fixture();
      for (let i = 0; i < 8; i++) attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      clean(db, 'thin', 1);
      const line = renderBlock(db, notes, NOW)
        .split(String.fromCharCode(10)).find((l) => l.includes('**thin**'))!;
      expect(line, '卡住的词那一行没写次数').toMatch(/9/);
      expect(line, '没写全对几次').toMatch(/全对/);
    });

    it('有讲解的**照样要列**，并把讲解标出来——那说明现有的讲解没起作用', () => {
      // 这是最重要的一条：dopamine detox 练了 35 次、全对率 11%，而它挂着三篇讲解。
      // 把"有讲解的"跳过去的话，恰恰漏掉了最该人去看的那一类。
      const { db, notes, dir } = fixture();
      writeFileSync(join(dir, 'w.md'), `---
id: about-thin
title: thin 这个词
triggers: []
words: [thin]
---
讲 thin 的。
`, 'utf8');
      notes.load();
      for (let i = 0; i < 8; i++) attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      const block = renderBlock(db, notes, NOW);
      expect(block).toContain('### 卡住的词');
      expect(block).toContain('**thin**');
      expect(block, '有讲解的被跳过了').toContain('thin 这个词');
    });

    it('没有讲这个词的笔记时，明说出来', () => {
      const { db, notes } = fixture();
      for (let i = 0; i < 8; i++) attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      expect(renderBlock(db, notes, NOW)).toMatch(/还没有讲这个词的笔记/);
    });
  });

  describe('该补的笔记：只推荐够格的', () => {
    function missingSection(db: Parameters<typeof renderBlock>[0], notes: Parameters<typeof renderBlock>[1]) {
      const block = renderBlock(db, notes, NOW);
      const i = block.indexOf('### 该补的笔记');
      return i < 0 ? '' : block.slice(i);
    }

    /**
     * **次数大的错误，永远不许无声消失。**
     *
     * 这一条是被真事逼出来的：/ɑ/→/æ/ 出现 17 次、是第二名的近两倍，
     * 因为"只在一个词上"被判据筛掉，而档案里只有一句笼统的
     * "其余的没列进来：3 次以下，或者只在一个词上出现过"——不点名、不给次数。
     * 于是它就那么消失了——次数最多的那个错，反而没人提。
     *
     * 门槛可以再调，判据可以再错——但**被筛掉的东西必须留下痕迹**，
     * 否则下一次调错门槛，同样的漏还会再发生一遍，而且同样没人看得见。
     * 这个仓库的套印带早就写着这条规矩：「忽略掉了什么要说出来，不能悄悄扣掉」。
     */
    it('次数够却没被推荐的，必须点名说出来——不能只留一句笼统的规则', () => {
      const { db, notes } = fixture();
      // 造一个"次数很大但判据不认"的：全在一个词上，且每条转写都还有别的错
      for (let i = 0; i < 17; i++) {
        attempt(db, 'thin', [
          { kind: 'sub', targetIpa: 'θ', heardIpa: 's' },
          { kind: 'del', targetIpa: 'n' },
        ]);
      }
      const block = renderBlock(db, notes, NOW);
      // 没进推荐清单
      const sec = block.indexOf('### 该补的笔记');
      expect(sec < 0 || !block.slice(sec).split('（3 次以下')[0].includes('- 把 /θ/ 发成了 /s/（17')).toBe(true);
      // **但它的名字和次数必须出现在档案里**，而且给了原因
      expect(block).toContain('把 /θ/ 发成了 /s/');
      expect(block).toMatch(/一个词|那次录音/);
      // **次数必须跟在名字旁边**。少了它，一条 17 次的和一条 3 次的看起来一样，
      // 而"这条到底多大"正是判断判据错没错的唯一依据。
      const line = block.split(/\r?\n/).find((l) => l.startsWith('- 把 /θ/ 发成了 /s/'))!;
      expect(line, '被筛掉的那条没写次数').toMatch(/17/);
    });

    it('统计表被 20 条上限截断时，必须出声', () => {
      // 一张看着"就这些"的表底下还藏着行，是最容易让人误判的一种呈现。
      // 造 22 种不同的错法，超过 PHONEME_STATS_LIMIT。
      const { db, notes } = fixture();
      const ipa = 'abcdefghijklmnopqrstuv'.split('');
      for (const c of ipa) attempt(db, 'thin', [{ kind: 'sub', targetIpa: c, heardIpa: 's' }]);
      const block = renderBlock(db, notes, NOW);
      expect(block).toMatch(/只列了|超过 20 种/);
    });

    it('次数不够的那些不逐条列——全列出来反而把该看的埋了', () => {
      const { db, notes } = fixture();
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }, { kind: 'del', targetIpa: 'n' }]);
      const block = renderBlock(db, notes, NOW);
      expect(block).not.toContain('次数够但暂时没推荐');
    });

    it('只出现两次 → 不推荐（正文说的是"反复出错"）', () => {
      const { db, notes } = fixture();
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      attempt(db, 'thought', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      expect(missingSection(db, notes)).not.toContain('把 /θ/ 发成了 /s/');
    });

    it('次数够但全在一个词上、而且那几条转写还错了别的 → 不推荐', () => {
      // 「那次录音本身就崩了」的样子：一条里好几处错。/d/→/t/ 那批就是这样
      // （转写是 ħ、t o x æ m i n），6 次全在 dopamine 一个词上。
      const { db, notes } = fixture();
      for (let i = 0; i < 6; i++) {
        attempt(db, 'thin', [
          { kind: 'sub', targetIpa: 'θ', heardIpa: 's' },
          { kind: 'sub', targetIpa: 'ɪ', heardIpa: 'æ' },
          { kind: 'del', targetIpa: 'n' },
        ]);
      }
      expect(missingSection(db, notes)).not.toContain('把 /θ/ 发成了 /s/');
    });

    it('跨词那条路照样管用——即使每条转写都还错了别的', () => {
      // 两条证据是**并列**的，不是"独占转写"取代了"跨词"。
      // 只留独占那半条的话，这一条会红：跨了三个词，但每条都不止一处错。
      const { db, notes } = fixture();
      for (const w of ['thin', 'thought', 'think']) {
        attempt(db, w, [
          { kind: 'sub', targetIpa: 'θ', heardIpa: 's' },
          { kind: 'del', targetIpa: 'n' },
        ]);
      }
      expect(missingSection(db, notes)).toContain('把 /θ/ 发成了 /s/');
    });

    it('独占转写只出现一两次，不够——那可能只是偶然', () => {
      // 门槛是 MIN_COUNT 次独占，不是"有过一次独占就算"。
      // 崩掉的录音里偶尔也会只错一处，一次说明不了什么。
      const { db, notes } = fixture();
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);   // 独占 1 次
      for (let i = 0; i < 4; i++) {
        attempt(db, 'thin', [
          { kind: 'sub', targetIpa: 'θ', heardIpa: 's' },
          { kind: 'del', targetIpa: 'n' },
        ]);
      }
      expect(missingSection(db, notes)).not.toContain('把 /θ/ 发成了 /s/');
    });

    it('只在一个词上，但每次都**独占整条转写** → 推荐', () => {
      // 这一条是 /ɑ/→/æ/ 那个真信号：17 次全在 detox 一个词上，
      // 但 15 次整条只错这一个音——其余的音模型全听对了。
      // 只看"跨几个词"的话，它跟上面那种崩掉的录音长得一模一样，会被一起筛掉。
      // 真出过的事故：次数最多的那个错被筛掉，一声不吭。
      const { db, notes } = fixture();
      for (let i = 0; i < 4; i++) {
        attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      }
      expect(missingSection(db, notes)).toContain('把 /θ/ 发成了 /s/');
    });

    it('次数够且跨词 → 推荐', () => {
      const { db, notes } = fixture();
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      attempt(db, 'thought', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      expect(missingSection(db, notes)).toContain('把 /θ/ 发成了 /s/');
    });

    it('被筛掉的照样出现在上面那张统计表里 —— 原始数据不该被观点过滤掉', () => {
      const { db, notes } = fixture();
      // 用"整条转写都崩了"那种形状，那才是会被筛掉的
      for (let i = 0; i < 6; i++) {
        attempt(db, 'thin', [
          { kind: 'sub', targetIpa: 'θ', heardIpa: 's' },
          { kind: 'del', targetIpa: 'n' },
        ]);
      }
      const block = renderBlock(db, notes, NOW);
      expect(block).toContain('把 /θ/ 发成了 /s/');           // 表里有
      expect(missingSection(db, notes)).not.toContain('把 /θ/');  // 建议里没有
    });

    it('门槛要写在正文里，不能静悄悄地筛', () => {
      const { db, notes } = fixture();
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      attempt(db, 'thin', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      attempt(db, 'thought', [{ kind: 'sub', targetIpa: 'θ', heardIpa: 's' }]);
      // 上面那张表里还有一条标着「还没有」但没被推荐的（1 次、单个词）
      attempt(db, 'need', [{ kind: 'del', targetIpa: 'd' }]);
      const sec = missingSection(db, notes);
      // 不锁文案，要求两件事：
      // ① 两条判据都交代出来
      expect(sec).toMatch(/3 次|≥3/);
      expect(sec).toMatch(/一个词/);
      // ② **两条判据都得交代**。只写"≥3 次"的话，"跨词 / 独占转写"那一条就成了暗规则，
      //    读的人看到一条 17 次的没进清单，无从判断是判据错了还是数据不够。
      expect(sec).toMatch(/一个词|整条转写/);
    });
  });

  it('三种错法都说成人话，不直接甩 kind 字面量', () => {
    const { db, notes } = fixture();
    attempt(db, 'night', [
      { kind: 'sub', targetIpa: 'n', heardIpa: 'l' },
      { kind: 'del', targetIpa: 't' },
      { kind: 'ins', heardIpa: 'ə' },
    ]);
    const block = renderBlock(db, notes, NOW);
    expect(block).toContain('把 /n/ 发成了 /l/');
    expect(block).toContain('/t/ 没发出来');
    expect(block).toContain('多发了一个 /ə/');
    expect(block).not.toMatch(/\|\s*(sub|del|ins)\s*\|/);
  });

  it('全对的那几次也计入总数，正确率不会算成 100%', () => {
    const { db, notes } = fixture();
    logAttempt(db, { entryText: 'night', target: 'night', at: NOW, targetIpa: ['n'], heardIpa: ['n'], ops: [{ kind: 'match', targetIpa: 'n', heardIpa: 'n' }], clean: true });
    attempt(db, 'light', [{ kind: 'sub', targetIpa: 'l', heardIpa: 'n' }]);
    const block = renderBlock(db, notes, NOW);
    expect(block).toContain('共 2 次评测');
    expect(block).toContain('1 次每个音都对上（50%）');
  });
});
