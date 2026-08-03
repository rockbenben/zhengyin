import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { PronounceResult } from '../types';

// Recorder 挂载时会问三件事（模型在不在、边车在不在、词典 key 配了没）。
// 这里测的是纯展示部分，把它们打成静默的桩，免得测试去碰真网络。
// 有确凿的替换错时还会渲染 PlaceRuler（部位尺），它要 /api/articulation。
// 只放测试里真的用到的那两个音素，形状照 types.ts 的 ArticulationTable。
const ART = {
  places: [
    { id: 'bilabial', label: '双唇' },
    { id: 'near-front', label: '偏前' },
    { id: 'near-back', label: '偏后' },
    { id: 'velar', label: '软腭' },
  ],
  manners: { stop: '塞音', vowel: '元音' },
  phones: [
    { kind: 'consonant', ipa: 'b', place: 'bilabial', manner: 'stop', voiced: true, nasal: false, howTo: '双唇闭合再放开' },
    { kind: 'vowel', ipa: 'ʊ', place: 'near-back', manner: 'vowel', voiced: true, nasal: false, howTo: '舌位偏后偏高，唇微圆' },
    { kind: 'vowel', ipa: 'æ', place: 'near-front', manner: 'vowel', voiced: true, nasal: false, howTo: '嘴角向两侧拉开，下巴放低' },
    { kind: 'consonant', ipa: 'k', place: 'velar', manner: 'stop', voiced: false, nasal: false, howTo: '舌根顶软腭再放开' },
  ],
};

// 可变的桩状态。vi.hoisted 是必须的：vi.mock 会被提到文件顶部，普通的 let
// 在工厂求值时还在 TDZ 里。
// 为什么要可变：第一版把 getMwKey 写死成 configured:false，于是"配了 key 就不该提设置页"
// 那一半从没被验证过——变异测试里"把分支写死成总是叫人去设置页"活了下来。
const stub = vi.hoisted(() => ({ mwKeyConfigured: false }));

vi.mock('../api', () => ({
  api: {
    pronounceHealth: () => Promise.resolve({ ok: true }),
    getMwKey: () => Promise.resolve({ configured: stub.mwKeyConfigured, masked: null }),
    confusions: () => Promise.resolve({ contrasts: [] }),
    articulation: () => Promise.resolve(ART),
  },
}));
vi.mock('../lib/asr', () => ({
  checkModelAvailability: () => Promise.resolve('available'),
  contrastAll: () => Promise.resolve([]),
  resetModel: () => {},
}));

const { default: Recorder, PhonemeResult, headline } = await import('./Recorder');
// 「模型拿不准」在界面上的叫法只有 lib/align.ts 一处定义。测试引用它而不是写死措辞：
// 换说法不该假红（这个文件顶上的规矩），而"屏幕上必须有话交代那个灰格子"仍然被守着。
const { UNSURE } = await import('../lib/align');

/**
 * 这个文件只回答一个问题：**PronounceResult 上那些影响"这个判定有多可信"的字段，
 * 有没有真的改变用户看到的东西。**
 *
 * 为什么单独立一类测试：这个项目栽过两次同样的跟头，两次都从类型检查底下溜过去了。
 * comparedWith 一路铺到 types.ts、注释里写明"模型在元音上的系统性偏置会掺进来"、
 * 服务端 3 个测试守着它的产出——而界面一个字都没渲染。类型检查看不出"声明了但没用"，
 * 纯函数测试也拦不住（可以写一个完美的判断函数然后忘记在 JSX 里调它）。
 *
 * 所以断言写成"渲染结果必须不同 / 必须提到某个概念"，**不去锁具体文案**——
 * 文案这个仓库改得很勤（「滑开了」「像发啊」「开始念」都被推翻过），
 * 锁字面量的测试会在每次措辞调整时假红，然后被人 skip 掉，最后等于没有。
 */

function result(over: Partial<PronounceResult> = {}): PronounceResult {
  return {
    target: 'book',
    targetIpa: ['b', 'ʊ', 'k'],
    words: [{ word: 'book', ipa: ['b', 'ʊ', 'k'] }],
    heardIpa: ['b', 'ʊ', 'k'],
    rawIpa: 'b ʊ k',
    comparedWith: 'reference',
    referenceIpa: ['b', 'ʊ', 'k'],
    baselineDrift: [],
    baselineRepaired: [],
    recorded: true,
    notRecordedReason: null,
    align: [
      { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
      { kind: 'match', targetIpa: 'ʊ', heardIpa: 'ʊ', conf: 0.81, sure: true },
      { kind: 'match', targetIpa: 'k', heardIpa: 'k', conf: 0.95, sure: true },
    ],
    notes: [],
    ...over,
  };
}

function drawEl(over: Partial<PronounceResult> = {}, mwKey: boolean | null = null) {
  const { container } = render(
    <MemoryRouter>
      <PhonemeResult result={result(over)} mwKey={mwKey} />
    </MemoryRouter>,
  );
  return container;
}

function draw(over: Partial<PronounceResult> = {}, mwKey: boolean | null = null) {
  return drawEl(over, mwKey).textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.mwKeyConfigured = false;   // 每个用例从"没配 key"起步，要另一种自己改
});

/**
 * 「录音」是这一页唯一要人动手的事，旁边两个（多数时候还是禁用的）按钮都在等它先发生。
 * 三个一样重的话，人得读完文字才知道该点哪个。
 */
describe('录音是这一页的主动作', () => {
  it('录音按钮要比旁边两个重', async () => {
    render(<MemoryRouter><Recorder target="book" entry="book" referenceUrl={null} /></MemoryRouter>);
    const rec = await screen.findByRole('button', { name: /录音/ });
    expect(rec.className).toContain('ant-btn-primary');
    // 对照：另外两个不能也是主按钮，否则等于都不是
    const others = screen.getAllByRole('button').filter((b) => !/录音/.test(b.textContent ?? ''));
    expect(others.length).toBeGreaterThan(0);
    for (const b of others) expect(b.className).not.toContain('ant-btn-primary');
  });
});

/**
 * 「评测」这个按钮在没录音之前不该出现。
 *
 * 它紧挨着的那句提示写的是「点『录音』念出来——念完它自己停，**然后自动评测**」。
 * 而按钮就摆在旁边、还是灰的：一句说自动、一个控件说手动，第一次用的人只会想
 * "到底要不要点它"。这是打开复习页一眼看出来的。
 *
 * 它真正有用的两个状态都在录完之后：自动那次跑过了 → 「重新评测」；
 * 自动那次失败了 → 「评测」，那时它确实是要人按的那一下。
 *
 * 「对比播放」不在此列——没有哪句话说它会自动发生，而且它为什么灰另有常驻说明。
 */
describe('没录音之前不摆一个说手动的按钮', () => {
  it('还没录音 → 页面上没有「评测」这个控件', async () => {
    render(<MemoryRouter><Recorder target="book" entry="book" referenceUrl={null} /></MemoryRouter>);
    await screen.findByRole('button', { name: /录音/ });
    // **匹配前必须把空白全去掉**：antd 会在「恰好两个汉字、且没有图标」的按钮里
    // 自动插一个空格，所以那个按钮的 textContent 是「评 测」不是「评测」。
    // 第一版没去空格，于是把"没录音也摆一个评测按钮"的变异放过去了——
    // 测试自己写错，看起来却像代码没问题。
    // （「录音」有图标所以不插；「对比播放」四个字也不插——只有这一个中招。）
    const names = screen.getAllByRole('button').map((b) => (b.textContent ?? '').replace(/\s/g, ''));
    expect(names.some((t) => /^重?新?评测$/.test(t)), `按钮有：${names.join('、')}`).toBe(false);
  });

  it('提示里说了「自动评测」——正因为如此才不该同时摆一个手动按钮', async () => {
    render(<MemoryRouter><Recorder target="book" entry="book" referenceUrl={null} /></MemoryRouter>);
    await screen.findByRole('button', { name: /录音/ });
    expect(document.body.textContent).toMatch(/自动评测/);
  });

  it('「对比播放」照旧在——它没有这个矛盾，而且它为什么灰另有说明', async () => {
    render(<MemoryRouter><Recorder target="book" entry="book" referenceUrl={null} /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /对比播放/ })).toBeTruthy();
  });
});

describe('comparedWith 必须影响渲染', () => {
  // 这一条就是当初漏掉的那个 bug 的守卫。它失败意味着：又有人能拿到
  // "跟词典比"的结果，却看到跟"跟真人录音比"一模一样自信的判定。
  it('跟词典比 和 跟真人录音比，渲染出来不能一样', () => {
    const ref = draw({ comparedWith: 'reference' });
    const dict = draw({ comparedWith: 'dictionary', referenceIpa: null });
    expect(dict).not.toBe(ref);
  });

  it('跟词典比时要说清基准是词典，并且提到元音不那么可信', () => {
    const text = draw({ comparedWith: 'dictionary', referenceIpa: null });
    expect(text).toContain('词典');
    expect(text).toContain('元音');
  });

  it('跟真人录音比时不提这一套——那是正常情况，多说只会稀释注意力', () => {
    const text = draw({ comparedWith: 'reference' });
    expect(text).not.toContain('跟词典音标比');
  });

  it('没配词典 key 时给得出下一步；配了就不该让人白跑设置页', () => {
    const noKey = draw({ comparedWith: 'dictionary', referenceIpa: null }, false);
    const hasKey = draw({ comparedWith: 'dictionary', referenceIpa: null }, true);
    expect(noKey).toContain('设置页');
    expect(hasKey).not.toContain('设置页');
    // 还没问到（null）时只说事实、不猜建议
    const unknown = draw({ comparedWith: 'dictionary', referenceIpa: null }, null);
    expect(unknown).not.toContain('设置页');
  });
});

/**
 * 参考基准的校准细节**不进评测流**。
 *
 * 先是「这把尺子有点歪」那条警告——把基准干活的样子当成了故障（基准跟词典不一致
 * 正是它存在的理由：book 的 /ʊ/ 被模型听成 /æ/）。删掉之后改用一行常驻说明
 * 「参考音有 N 处已按你的录音改回词典值：第 4 个音…」——同一个错换了个样子。
 *
 * 想清楚听众是谁：纠正修的正是"你觉得自己念对了、工具却说错"那种情况，
 * 而修完之后那种情况就不会发生了。所以那行字没有听众，只有噪音。
 * 两版都是在实际使用中被指出来的——一个单词下面挂一长串校准说明，喧宾夺主。
 */
describe('基准的校准细节不进评测流', () => {
  it('基准跟词典差几处 → 一个字都不说', () => {
    expect(draw({ baselineDrift: [1, 3, 5] })).not.toMatch(/尺子|歪|打折扣|未必是你的错/);
  });

  it('按你的录音纠正过 → 也不在这里说', () => {
    const text = draw({
      baselineDrift: [1, 3, 5],
      baselineRepaired: [{ index: 5, from: 'eɪ', to: 'i', times: 10 }],
    });
    expect(text, '校准细节又摆进评测流了').not.toMatch(/改回|纠正|参考音有/);
  });
});

/**
 * 「怎么改」全部收着，点哪篇由人自己定。
 *
 * 走过两版才到这儿：先是"每一篇都摊开"——一次好录音反而铺出最长的一屏
 * （两篇 × 三百多字），短语逐词录更长；改成"只摊开第一篇"，使用者还是说不要：
 * 「怎么改 这个就不要自动打开，让用户自己判断打开哪个」。
 *
 * 光"少铺一点"不够。**自动摊开哪一篇，等于替用户决定
 * 先练什么**——而"哪处错最要紧、今天想练哪个"这个判断只有他自己做得了。
 * 排序仍然按相关性（讲这个词的排最前），那是建议；摊不摊开是决定，交回去。
 */
describe('怎么改：全部收着，点哪篇由人自己定', () => {
  const twoNotes = [
    { id: 'a', title: '第一篇', severity: 'confirmed', guidance: [{ heading: '自检法', body: '甲的正文' }] },
    { id: 'b', title: '第二篇', severity: 'info', guidance: [{ heading: '自检法', body: '乙的正文' }] },
  ] as PronounceResult['notes'];

  function panels(over: Partial<PronounceResult>) {
    const c = drawEl({
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'sub', targetIpa: 'ʊ', heardIpa: 'æ', conf: 0.9, sure: true },
      ],
      notes: twoNotes,
      ...over,
    });
    return c.textContent ?? '';
  }

  it('一篇正文都不摊开——包括排在最前的那篇', () => {
    const text = panels({});
    expect(text, '第一篇被自动摊开了').not.toContain('甲的正文');
    expect(text, '第二篇被自动摊开了').not.toContain('乙的正文');
  });

  it('标题全在，而且点得开——收起来不等于藏起来', () => {
    const text = panels({});
    expect(text).toContain('第一篇');
    expect(text).toContain('第二篇');
  });

  it('点开之后正文才出现', () => {
    // 不摊开的前提是"点得开"。这一条守的就是那个前提：
    // 只把 defaultActiveKey 清空、却没给可点的入口，等于把讲解删了。
    const c = drawEl({
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'sub', targetIpa: 'ʊ', heardIpa: 'æ', conf: 0.9, sure: true },
      ],
      notes: twoNotes,
    });
    const head = [...c.querySelectorAll<HTMLElement>('.ant-collapse-header')]
      .find((h) => h.textContent?.includes('第二篇'));
    expect(head, '第二篇没有可点的标题').toBeDefined();
    fireEvent.click(head!);
    expect(c.textContent, '点开了却没出正文').toContain('乙的正文');
  });

  it('没有错的时候整块讲解都不出现', () => {
    const text = panels({
      align: [{ kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true }],
    });
    expect(text).not.toContain('甲的正文');
    expect(text).not.toContain('第一篇');
  });
});

describe('判定本身要落到屏幕上', () => {
  it('全对时说全对', () => {
    expect(draw()).toContain('每个音都发对了');
  });

  it('确凿的错必须出现，而且要点出错在哪个音', () => {
    const text = draw({
      heardIpa: ['b', 'æ', 'k'],
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'sub', targetIpa: 'ʊ', heardIpa: 'æ', conf: 0.9, sure: true },
        { kind: 'match', targetIpa: 'k', heardIpa: 'k', conf: 0.95, sure: true },
      ],
    });
    expect(text).not.toContain('每个音都发对了');
    expect(text).toContain('ʊ');
    expect(text).toContain('æ');
  });

  it('模型拿不准的替换不算错，但要让人知道它被搁置了', () => {
    // conf 低于 CONFIDENT(0.5)：不该判成错，可也不能悄悄藏起来——
    // 藏起来的话模型真听岔了你完全不知道，反而更难查（Recorder.tsx 里的原话）。
    const text = draw({
      heardIpa: ['b', 'æ', 'k'],
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        // sure:false 是服务端算好的（conf 0.2 < CONFIDENT）；前端只认 sure，不看 conf
        { kind: 'sub', targetIpa: 'ʊ', heardIpa: 'æ', conf: 0.2, sure: false },
        { kind: 'match', targetIpa: 'k', heardIpa: 'k', conf: 0.95, sure: true },
      ],
    });
    // **不能说「每个音都发对了」。**「没有确凿的错」不等于「对」——
    // 模型在那一处听到的是别的音，只是没把握。原来标题照说全对、更正藏在下面的灰字里，
    // 而人读的是标题。实测 47 次评测里 6 次判全对，5 次是这么来的
    // （最刺眼的 thin [θ ɪ n] → [f ɛ n] 被记成了每个音都对）。
    expect(text).not.toContain('每个音都发对了');
    // 但也不能报成确凿的错——它仍然是"没测准"，不是"你错了"
    expect(text).toMatch(/没测准|没把握/);
    expect(text).toContain(UNSURE);
  });

  it('真的每个音都对上才说全对——三态之间不许互相冒充', () => {
    const allMatch = draw({
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'match', targetIpa: 'ʊ', heardIpa: 'ʊ', conf: 0.95, sure: true },
      ],
    });
    expect(allMatch).toContain('每个音都发对了');
    expect(allMatch).not.toMatch(/没测准/);
  });

  it('拿不准的**多余音**不影响"全对"——那几乎只能是杂音', () => {
    // isNoise 的分工：多余音的不确定是"那儿到底有没有音"，
    // 跟"那个音是什么"的不确定不是一回事，不该把一次好录音判成没测准。
    const text = draw({
      heardIpa: ['b', 'ʊ', 'k'],
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'match', targetIpa: 'ʊ', heardIpa: 'ʊ', conf: 0.95, sure: true },
        { kind: 'ins', heardIpa: 'ə', conf: 0.2, sure: false },
        { kind: 'match', targetIpa: 'k', heardIpa: 'k', conf: 0.95, sure: true },
      ],
    });
    expect(text).toContain('每个音都发对了');
  });

  it('拿不准的错要标出来，而对上的音不受影响——两侧都断言，别只守一半', () => {
    // 上一版这条只断言"出现了不确定"这一个字面量，于是把 tick() 改成**无条件**返回
    // 「不确定」（连有把握的 match 也标成拿不准）照样全绿——只守了一半。
    // 而且锁字面量本身违反这个文件顶上的规矩：同一个概念仓库里就有三种写法
    // 措辞收成了 lib/align.ts 的 UNSURE 一处，这里引用它。
    //
    // 所以改成断言**两侧的区分**：拿不准的那处跟对上的那些渲染结果必须不同，
    // 且对上的音不能跟着变成拿不准。至于"拿不准"具体怎么措辞，不锁。
    const confident = draw({
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'match', targetIpa: 'ʊ', heardIpa: 'ʊ', conf: 0.95, sure: true },
      ],
    });
    const withUnsure = draw({
      heardIpa: ['b', 'æ'],
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        // sub + 低置信 = 服务端真能吐出来的"拿不准的错"（match 恒 sure，见 app.ts）
        { kind: 'sub', targetIpa: 'ʊ', heardIpa: 'æ', conf: 0.2, sure: false },
      ],
    });
    expect(withUnsure).not.toBe(confident);
    // 屏幕上必须有话交代那个灰格子，不能只剩一个没人解释的灰块。
    // **摘要也不能说全对**——那一处模型听到的是别的音，只是没把握，
    // 这次是"没测准"，不是"对"。（这条断言原来写的是 toContain('每个音都发对了')，
    // 守的正是那个说谎的标题。）
    expect(withUnsure).not.toContain('每个音都发对了');
    expect(withUnsure).toContain(UNSURE);
    // 全都有把握时，不该冒出任何"存疑"的交代
    expect(confident).not.toContain(UNSURE);

    // **同一次渲染里，有把握的格子和拿不准的格子小注必须不同。**
    // 这一条是变异测试逼出来的：只断言"出现了某个词"的话，把 tick() 改成无条件返回
    // 「不确定」（连对上的音也标成拿不准）照样全绿。断言"两者不同"既杀掉那个变异，
    // 又不锁任何具体措辞——措辞这个仓库改得很勤。
    const ticks = [...drawEl({
      heardIpa: ['b', 'æ'],
      align: [
        { kind: 'match', targetIpa: 'b', heardIpa: 'b', conf: 0.97, sure: true },
        { kind: 'sub', targetIpa: 'ʊ', heardIpa: 'æ', conf: 0.2, sure: false },
      ],
    }).querySelectorAll('.op-tick')].map((e) => e.textContent);
    expect(new Set(ticks).size).toBeGreaterThan(1);
  });

  it('这次没计入统计时，界面必须说出来', () => {
    // 静悄悄地不计入比计入更糟：你会以为练过的都算数，而档案里根本没有这一次。
    // 这个字段是服务端在背景太吵时置的（RECORD_MIN_SNR_DB），界面只负责显示结论。
    const kept = draw({ recorded: true, notRecordedReason: null });
    const dropped = draw({
      recorded: false,
      notRecordedReason: '背景噪音偏大（信噪比 12dB），这次不计入统计和复习队列',
    });
    // 不锁文案，只要求"渲染结果必须不同"且提到那两个概念
    expect(dropped).not.toBe(kept);
    expect(dropped).toContain('计入');
    expect(dropped).toMatch(/复习|档案/);
    // 反过来：正常计入的那次不该冒出这段提示，否则每次评测都在喊"没计入"
    expect(kept).not.toContain('不会沉淀');
  });

  it('一个音都没识别出来时，不能装作"全对"', () => {
    // 空的 heardIpa 走的是另一条分支。这里最危险的错法是让它落进
    // "wrong.length === 0 → 每个音都发对了"，那等于对着一段静音说你念对了。
    const text = draw({ heardIpa: [], align: [] as PronounceResult['align'] });
    expect(text).not.toContain('每个音都发对了');
    expect(text).toContain('再录一次');
  });
});

/**
 * 第二个漏掉过的地方：没有参考音时「对比播放」被 disabled，却不给任何理由。
 * 这跟仓库自己的做法不一致——micError 那段注释明确要求"权限被拒必须常驻说明去哪儿改"，
 * 独独这个控件是默默变灰的。
 *
 * 这里渲染整个 Recorder（挂载时那三个请求已经打了桩），因为这块渲染在 Recorder 本体、
 * 不在 PhonemeResult 里。
 */
describe('禁用的控件必须说明为什么', () => {
  const mount = (referenceUrl: string | null) =>
    render(
      <MemoryRouter>
        <Recorder target="book" entry="book" referenceUrl={referenceUrl} />
      </MemoryRouter>,
    );

  // 原生断言，省掉 @testing-library/jest-dom 这个依赖——只为一个 toBeDisabled 不值得
  const abDisabled = () =>
    (screen.getByRole('button', { name: /对比播放/ }) as HTMLButtonElement).disabled;

  it('没有参考音时：按钮禁用，并且说清为什么、还能做什么', async () => {
    mount(null);
    expect(abDisabled()).toBe(true);
    // mwKey 的桩是 configured:false，所以该给出"去设置页配 key"这条路
    await waitFor(() => {
      expect(document.body.textContent).toContain('设置页');
    });
    expect(document.body.textContent).toContain('参考');
  });

  it('配了词典 key 还是没有参考音：不该叫人白跑设置页', async () => {
    // 这条是变异测试逼出来的。原来只测了"没配 key"，于是把分支写死成
    // "总是叫人去设置页"照样全绿——等于这一半逻辑根本没有网。
    // 配了 key 还没抓到参考音，说明是这个词本身没真人录音（或短语只有合成音），
    // 去设置页什么也解决不了。
    stub.mwKeyConfigured = true;
    mount(null);
    await waitFor(() => expect(document.body.textContent).toContain('对比播放用不了'));
    expect(document.body.textContent).not.toContain('设置页');
  });

  it('有参考音时：不出现这条说明（按钮只因为还没录音而灰，那不用解释）', async () => {
    mount('/api/audio/book-mw.mp3');
    // 先等挂载时那几个请求落地，再断言"没有"——否则 waitFor 在第一个 tick 就通过了，
    // 那种断言对"说明来得晚一点"完全无效。
    await waitFor(() => expect(document.body.textContent).toContain('对比播放'));
    expect(document.body.textContent).not.toContain('对比播放用不了');
    expect(screen.queryByText(/没有参考音/)).toBeNull();
    // 还没录音，所以仍然是禁用的——但这种禁用是自明的
    expect(abDisabled()).toBe(true);
  });
});

/**
 * 「你发出来的」不能跟同一屏的标题打架。
 *
 * 使用者发现的：cup 判成「每个音都发对了」，下一行却写着「你发出来的 [kæp]」——
 * cup 是 /kʌp/，那句话在说他念成了 cap。**同屏矛盾，人信音标。**
 *
 * 怎么来的：模型对低元音有个含糊符号（真人 cup 录音也被转成同一个），参考基准
 * 两边抵消所以判定正确；但这一行读的是**模型的原始转写**，而 align 上的 match
 * 早就被服务端强制成"两版同字"了。同一件事两套规则——CONFIDENT 的 0.5 也这么栽过。
 */
describe('你发出来的：念判定之后那一串', () => {
  it('每个音都对上时，显示的就是目标音，不是模型的原始符号', () => {
    const text = draw({
      // 服务端对 match 已经强制 heardIpa = targetIpa
      align: [
        { kind: 'match', targetIpa: 'k', heardIpa: 'k', conf: 0.9, sure: true },
        { kind: 'match', targetIpa: 'ʌ', heardIpa: 'ʌ', conf: 0.9, sure: true },
        { kind: 'match', targetIpa: 'p', heardIpa: 'p', conf: 0.9, sure: true },
      ],
      heardIpa: ['k', 'æ', 'p'],       // 模型原样：跟"全对"直接矛盾
      notes: [],
    });
    expect(text, '把模型的原始符号当成了"你发出来的"').not.toContain('kæp');
    expect(text).toContain('kʌp');
  });

  it('真发错了照样显示你发的那个音', () => {
    const text = draw({
      align: [
        { kind: 'match', targetIpa: 'l', heardIpa: 'l', conf: 0.9, sure: true },
        { kind: 'sub', targetIpa: 'ɑ', heardIpa: 'æ', conf: 0.9, sure: true },
      ],
      heardIpa: ['l', 'æ'],
      notes: [],
    });
    expect(text, '把真错也抹掉了').toContain('læ');
  });

  it('没发出来的音不进"你发出来的"', () => {
    // del 说的就是"这个音你没发出来"，出现在这一行里是自相矛盾
    const text = draw({
      align: [
        { kind: 'match', targetIpa: 'θ', heardIpa: 'θ', conf: 0.9, sure: true },
        { kind: 'match', targetIpa: 'ɪ', heardIpa: 'ɪ', conf: 0.9, sure: true },
        { kind: 'del', targetIpa: 'n', sure: true },
      ],
      heardIpa: ['θ', 'ɪ'],
      notes: [],
    });
    expect(text).toContain('θɪ');
    expect(text, '漏掉的音被算进"你发出来的"了').not.toContain('θɪn');
  });
});

/**
 * 录音 → 评测 → 结果，这三次变化都不是用户点出来的：屏幕上看得见，
 * 而读屏那边**全程无声**（实测词条页一个 aria-live / role=status 都没有）。
 */
describe('结果出来时，读屏那边也得知道', () => {
  it('活动区常驻——节点跟内容同时出现的话，读屏未必会念', () => {
    const { container } = render(
      <MemoryRouter><Recorder target="book" entry="book" referenceUrl={null} /></MemoryRouter>,
    );
    const live = container.querySelector('[role="status"]');
    expect(live, '没有常驻的活动区').not.toBeNull();
    // 还没录的时候它是空的，但节点必须已经在
    expect(live!.textContent).toBe('');
  });

  it('播报的那句话跟屏幕上那句是同一句', () => {
    const r = result({
      align: [{ kind: 'sub', targetIpa: 'θ', heardIpa: 'f', conf: 0.9, sure: true }],
      heardIpa: ['f'],
    });
    // headline 是两处共用的那一个来源：屏幕上那行标题，和活动区里播报的那句
    expect(drawEl({
      align: r.align, heardIpa: r.heardIpa,
    }).textContent).toContain(headline(r));
  });

  it('四种结果各有各的说法，不能混成一句', () => {
    const say = (over: Partial<PronounceResult>) => headline(result(over));
    const 全对 = say({});
    const 有错 = say({ align: [{ kind: 'sub', targetIpa: 'θ', heardIpa: 'f', conf: 0.9, sure: true }] });
    const 没把握 = say({ align: [{ kind: 'sub', targetIpa: 'θ', heardIpa: 'f', conf: 0.3, sure: false }] });
    const 没听出 = say({ heardIpa: [] });
    expect(new Set([全对, 有错, 没把握, 没听出]).size, '有两种结果说的是同一句话').toBe(4);
    expect(没听出).toMatch(/再录一次/);
    expect(没把握).toMatch(/没测准|再念一遍/);
  });
});
