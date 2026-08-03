import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { NoteStore, validateShape, type Note } from './notes.js';

/**
 * 笔记正文里那两节硬性的：自检法、对比训练。
 *
 * ── 为什么值得一条校验 ──
 *
 * 笔记模板原来把六段并列，还写着「`notes/` 里现有两篇就是范例」。而那两篇
 * （kl-cluster、l-vs-n，都是 7-28 加进来的）恰恰是**唯一不照模板写的两篇**——
 * kl-cluster 缺「自检法」和「对比训练」，后者更是一个 minimal pair 都没有。
 * **照着「看范例」做的人，产出的就是不合模板的笔记**，而没有任何东西会红。
 *
 * 只查这两节：没有自检法，笔记就退回成"多听多练"，而这个仓库存在的前提正是
 * 你不知道自己念得对不对；没有对比训练，"哪里不一样"就只能靠感觉。
 * 另外四段是建议——讲词的笔记本来就不该套「音标与定位」那一套。
 */
function note(markdown: string): Note {
  return {
    id: 'n', title: 't', triggers: ['phoneme:l'], contrasts: [], words: [],
    severity: 'info', markdown, file: 'n.md',
  };
}

const 原理 = ['## 发音原理', '舌尖顶上齿龈。', ''].join('\n');
const 自检 = ['## 自检法', '捏住鼻子念。', ''].join('\n');
const 对比 = ['## 对比训练', '脑 / 老。', ''].join('\n');

describe('validateShape：自检法和对比训练是硬性的', () => {
  it('两节都在 → 不吭声', () => {
    expect(validateShape([note(原理 + 自检 + 对比)])).toEqual([]);
  });

  it('缺自检法 → 告警，而且说得出为什么该有它', () => {
    const w = validateShape([note(原理 + 对比)]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('自检');
    // 只说"缺了"的告警会被当噪音忽略——这个仓库已经有一条 trigger 告警是这么被无视的
    expect(w[0], '没说为什么该有').toMatch(/多听多练|验证/);
  });

  it('缺对比训练 → 告警', () => {
    const w = validateShape([note(原理 + 自检)]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('对比');
  });

  // 认小节标题，不认正文里散着的一句话。kl-cluster 当初就是这样：全文最后一行有
  // 「自检：如果你能把 clean 和"克林"区分开」，却没有这一节——读者在
  // "我到底做对没有"的时候回头翻不到。
  it('正文里散着一句「自检：…」不算，得是独立小节', () => {
    const w = validateShape([note(['## 发音原理', '自检：对着镜子看。', ''].join('\n') + 对比)]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('自检');
  });

  it('标题叫「英文 minimal pairs」也算——各篇叫法不一样，不锁死一个词', () => {
    const md = 自检 + ['## 英文 minimal pairs', 'thin / thing', ''].join('\n');
    expect(validateShape([note(md)])).toEqual([]);
  });

  it('告警要点出是哪一篇、哪个文件——不然九篇里不知道该改哪个', () => {
    const w = validateShape([{ ...note(''), id: 'kl-cluster', file: 'kl-click-辅音连缀.md' }]);
    expect(w.join(' ')).toContain('kl-cluster');
    expect(w.join(' ')).toContain('kl-click-辅音连缀.md');
  });

  // ── 正文里不许对读者作实测断言 ──
  //
  // severity 那次改的是**标签**，正文里的判决留了下来：「/n/ 是你最大的一个问题」
  // 「误区一（你正在犯的）」「你自己踩过的那两个」。别人克隆下来，读到的是上一个
  // 使用者的诊断书，而措辞是第二人称——跟当初那个 severity 一样是句假话。
  it('「占你全部错误的 34%」这种句子要告警', () => {
    const w = validateShape([note(自检 + 对比 + '\n占你全部错误的 34%，是最大的一项。\n')]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('实测断言');
    // 只说"不许写"没用，得说清为什么——这是别人的数
    expect(w[0], '没说为什么不该写').toMatch(/不是读这篇的人|写笔记那个人/);
  });

  it('「你自己踩过的那两个」也要告警——「你」当了踩/犯的主语', () => {
    expect(validateShape([note(自检 + 对比 + '\n### 你自己踩过的那两个\n')])).toHaveLength(1);
    expect(validateShape([note(自检 + 对比 + '\n误区一（你正在犯的）：按字母念。\n')])).toHaveLength(1);
  });

  // 判据只认 次/% 而不是所有数字，就是为了这一条：教学里说"你"完全正当，
  // 按"你 + 数字"去拦会把正当的自检法误伤掉。
  it('「拖长 2 秒，听你拖出来的是什么」不算——那是自检法，不是断言', () => {
    expect(validateShape([note(自检 + 对比 + '\n故意把弱读音节拖长 2 秒，听你拖出来的是什么。\n')]))
      .toEqual([]);
  });

  // 仓库自带的这几篇必须自己过关。模板点着它们当范例，而范例不合模板
  // 正是这次要修的病——只写一条规则、不修既有的笔记，等于把病留在样板里。
  it('仓库里现有的笔记全部合格', () => {
    const store = new NoteStore(join(import.meta.dirname, '..', '..', 'notes'));
    // **构造函数不读盘**（只存 dir），得显式 load()。少这一句 all() 就是空数组，
    // validateShape([]) 恒等于 []，这条用例就永远绿——第一版正是这么写的，
    // 变异测试（把 kl-cluster 的自检法整节删掉）照样全过才发现。
    store.load();
    expect(store.all().length, '一篇笔记都没读到，这条用例是空过的').toBeGreaterThanOrEqual(5);
    const w = validateShape(store.all());
    expect(w, `这些笔记缺硬性小节：${w.join(' / ')}`).toEqual([]);
  });
});
