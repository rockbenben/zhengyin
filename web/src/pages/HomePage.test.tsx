import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { EntryListItem } from '../types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 首页是整个工具的**大门**，而这里守的两件事都是"接线接没接上"那一类——
 * 类型检查看不出"声明了但没用"，纯函数测试也拦不住（可以写一个完美的取数函数
 * 然后忘了在 JSX 里用它）。这个仓库在这类 bug 上栽过两次，两次都从类型检查底下溜过去了。
 *
 * 断言一律写成「渲染结果必须不同 / 必须提到某个概念」，**不锁具体文案**：
 * 这个仓库文案改得勤，锁字面量会在每次措辞调整时假红，然后被 skip 掉，最后等于没有。
 */

const stub = vi.hoisted(() => ({
  entries: [] as EntryListItem[],
  due: 0,
  added: [] as string[],
  /** 服务端认得的音素。不在这张表里的一律 404，跟真实的 /api/phonemes/:ipa 一致 */
  phonemes: ['θ', 'ɑ', 'æ'] as string[],
  /** 记下问过哪些——用来断言"根本没去问" */
  phonemeAsked: [] as string[],
  navigated: [] as string[],
}));

vi.mock('../api', () => ({
  isOffline: () => false,
  api: {
    listEntries: () => Promise.resolve({ entries: stub.entries }),
    health: () => Promise.resolve({ mwConfigured: true }),
    reviewDue: () => Promise.resolve({ cards: Array.from({ length: stub.due }, () => ({})) }),
    // TodayPlan 也挂在首页上，它要 stats。桩里漏一个函数的话，
    // 整页在 useEffect 里抛 TypeError——首页几条用例就是这么一起红的。
    stats: () => Promise.resolve({
      overall: { attempts: 0, clean: 0, words: 0, firstAt: null, lastAt: null },
      stuck: [], phonemes: [],
    }),
    addEntry: (text: string) => {
      stub.added.push(text);
      return Promise.resolve({ text, words: [{ word: text, found: true }] });
    },
    deleteEntry: () => Promise.resolve({}),
    phoneme: (ipa: string) => (stub.phonemeAsked.push(ipa), stub.phonemes.includes(ipa)
      ? Promise.resolve({ phone: { ipa } })
      : Promise.reject(new Error('404'))),
  },
}));

// 记下跳去了哪儿——"跳到音素页"这件事没法从渲染结果看出来
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => (to: string) => stub.navigated.push(to) };
});

const { default: HomePage } = await import('./HomePage');

function entry(text: string): EntryListItem {
  return {
    text, ipa: 'x', updatedAt: '2026-07-30T00:00:00.000Z',
    noteCount: 0, audioSource: 'mw',
  } as EntryListItem;
}

async function draw() {
  const { container } = render(<MemoryRouter><HomePage /></MemoryRouter>);
  // 三个请求都是异步的，等页头出来再断言。
  // **不能等 .ant-spin 消失**——antd 的 Table 内部自带一个 Spin，有词条时它一直在，
  // 那个条件永远不成立（第一版就是这么写的，四个用例全卡在这儿）。
  //
  // 用 within(container) 而不是 screen：**screen 查的是整个 document.body**，
  // 而 cleanup 是每个用例之后才跑、不是每次 render 之后。同一个用例里画两次
  // （对照"这个字段变了，画面得跟着变"就得画两次），body 里就有两个页头，
  // getByText 撞见多个匹配直接抛——表现出来是全量跑的时候偶发红，单独跑又是绿的。
  await waitFor(() => expect(within(container).getByText(/先查一个词|已经查过/)).toBeTruthy());
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.entries = [];
  stub.due = 0;
  stub.added = [];
  stub.navigated = [];
  stub.phonemeAsked = [];
});

/**
 * 首页归查词，复习归侧栏。
 *
 * 这里一度用 h1 写「有 3 个词要复习」并配一个「开始复习」按钮，于是同一件事在一屏里
 * 说三遍：侧栏的「复习 3」、这个标题、这个按钮。而侧栏那个角标翻到哪一页都在。
 *
 * 「到期数必须改变用户看到的东西」这条保证没有作废，只是搬到了它真正生效的地方
 * ——见 layout.test.tsx。这里守的是**反过来的那一半**：首页别再抢一次。
 */
describe('首页是查词页，不重复侧栏的复习入口', () => {
  it('无论有没有到期，头版都是档案本身', async () => {
    stub.entries = [entry('click'), entry('glass')];
    stub.due = 3;
    expect((await draw()).querySelector('h1')?.textContent).toMatch(/已经查过/);
    stub.due = 0;
    expect((await draw()).querySelector('h1')?.textContent).toMatch(/已经查过/);
  });

  // 恰好是被删掉那条的反面，用同一套机制：到期数变了，这一页一个像素都不该动。
  // 比"页面上不许出现 /review 链接"准——「怎么用」那四步里本来就有一句
  // 「反复错的自动进<复习>队列」，那是讲流程，不是又一个催你去练的按钮。
  it('到期数不再改变首页——它只改侧栏（见 layout.test.tsx）', async () => {
    stub.entries = [entry('click')];
    stub.due = 0;
    const none = (await draw()).textContent;
    stub.due = 5;
    const some = (await draw()).textContent;
    expect(some).toBe(none);
  });
});

/**
 * 冷启动最卡人的一步是「先查一个词」——查哪个？他不知道自己哪些音有问题，
 * 而那恰恰是他来用这个工具的原因。让人凭空想一个英文单词，等于把第一道门焊死。
 */
describe('空库时必须给起步词', () => {
  it('库是空的 → 摆出一排能直接点的词', async () => {
    stub.entries = [];
    const c = await draw();
    const buttons = [...c.querySelectorAll('button')].map((b) => b.textContent?.trim());
    // 不锁具体是哪几个词（选词会调整），只要求"给了好几个能点的词"
    expect(buttons.filter((t) => t && /^[a-z]+$/.test(t)).length).toBeGreaterThanOrEqual(4);
    // 每个词都得说清为什么是它——只给一排光秃秃的单词等于没解释
    expect(c.textContent).toMatch(/音节|元音|重音|中文里没有/);
  });

  it('点一个起步词 → 真的去建词条，不是个摆设', async () => {
    stub.entries = [];
    const c = await draw();
    const btn = [...c.querySelectorAll('button')].find((b) => /^[a-z]+$/.test(b.textContent?.trim() ?? ''));
    expect(btn).toBeDefined();
    btn!.click();
    await waitFor(() => expect(stub.added.length).toBe(1));
    expect(stub.added[0]).toBe(btn!.textContent?.trim());
  });

  it('库里已经有词了 → 不再摆起步词，那是给新手的', async () => {
    stub.entries = [entry('click'), entry('glass')];
    const c = await draw();
    expect(c.textContent).not.toMatch(/不知道从哪个词开始/);
  });

  /**
   * 起步词要排在「怎么用」前面。
   *
   * 标题是「先查一个词」，而新用户当场卡住的正是**查哪个**——起步词就是那个答案，
   * 得挨着问题。原来它排在整页最后：四步说明 + 一整段讲 AI 的话 + 一条配词典 key
   * 的提示全挡在前面，两百多字之后才轮到它。
   *
   * 这个顺序问题在本机永远看不见——库里有四十多个词条，根本走不到空库那条路。
   * 是拉出全新用户的第一屏、把文字原样打出来才发现的。
   */
  it('起步词排在「怎么用」前面——先给能点的，再给要读的', async () => {
    stub.entries = [];
    const c = await draw();
    const t = c.textContent ?? '';
    const 起步 = t.indexOf('不知道从哪个词开始');
    const 怎么用 = t.indexOf('怎么用');
    expect(起步, '没找到起步词那一块').toBeGreaterThanOrEqual(0);
    expect(怎么用, '没找到「怎么用」那一块').toBeGreaterThanOrEqual(0);
    expect(起步, '起步词被排到「怎么用」后面去了').toBeLessThan(怎么用);
  });

  it('输入框里有字时不摆起步词——那时候该说的是「库里还没有这个词」', async () => {
    stub.entries = [];
    const c = await draw();
    const input = c.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'zzz' } });
    await waitFor(() => expect(c.textContent).toMatch(/库里还没有/));
    expect(c.textContent).not.toMatch(/不知道从哪个词开始/);
  });
});

/**
 * 打一个音进来的人，想看的是「这个音怎么发」，而不是建一个词条。
 *
 * 原来一律走建词条：CMUdict 查不到 → 词条被删掉 → 弹一句
 * 「词典里没有「θ」，检查一下拼写。专有名词和缩写要手工给音标」。
 * **给一个念音的人的却是拼写建议**——而他要的东西这个应用早就有了：
 * 41 个音素每个都有「怎么发」，一句都不用问 AI。
 */
describe('输入一个音标', () => {
  it('是音素 → 跳到那个音的页面，不建词条', async () => {
    stub.entries = [];
    const c = await draw();
    // fireEvent.change 会绕过 React 受控输入的 value tracker；
    // 直接赋 value + dispatch('input') 是没用的（第一版就是那么写的，两条全没触发）
    fireEvent.change(c.querySelector('input')!, { target: { value: 'θ' } });
    fireEvent.click([...c.querySelectorAll('button')].find((b) => /查这个词/.test(b.textContent ?? ''))!);
    await waitFor(() => expect(stub.navigated.length).toBe(1));
    expect(stub.navigated[0]).toContain('/phoneme/');
    // **关键**：一条垃圾词条都没建
    expect(stub.added).toEqual([]);
  });

  it('不是音素 → 照常建词条，别把普通词也拦下来', async () => {
    stub.entries = [];
    const c = await draw();
    fireEvent.change(c.querySelector('input')!, { target: { value: 'cat' } });
    fireEvent.click([...c.querySelectorAll('button')].find((b) => /查这个词/.test(b.textContent ?? ''))!);
    await waitFor(() => expect(stub.added.length).toBe(1));
    expect(stub.added[0]).toBe('cat');
    expect(stub.navigated.some((t) => t.includes('/phoneme/'))).toBe(false);
  });

  it('长一点的词根本不去问音素接口——没有哪个音素有四个字符', async () => {
    // 「什么都先当音素试一遍」不会出错，但每建一个词条都白白多一次 404 往返，
    // 而且把一条"这不可能是音素"的知识丢掉了。
    stub.entries = [];
    stub.phonemeAsked = [];
    const c = await draw();
    fireEvent.change(c.querySelector('input')!, { target: { value: 'comfortable' } });
    fireEvent.click([...c.querySelectorAll('button')].find((b) => /查这个词/.test(b.textContent ?? ''))!);
    await waitFor(() => expect(stub.added.length).toBe(1));
    expect(stub.phonemeAsked, '不该为一个 11 个字符的词去问音素接口').toEqual([]);
  });
});

/**
 * 调色板自己写着 `red: 只给破坏性操作`（theme.ts）。而 antd 的 Badge 取 colorError，
 * 于是「命中笔记数」——一个中性、甚至算好事的计数——被渲染成整页最饱和的红点，
 * 在表里重复二十多次；同一行里「删除」也是红的，两个红互相抢。
 * 这条守的是：**红只留给那个删除**。
 */
describe('红只给破坏性操作', () => {
  it('讲解篇数用蓝版，不用红色徽章', async () => {
    stub.entries = [{ ...entry('click'), noteCount: 2 }];
    const c = await draw();
    // antd Badge 会渲染 .ant-badge-count；这里不该有
    expect(c.querySelector('.ant-badge-count')).toBeNull();
    // 篇数照样看得见，而且是蓝的
    const cell = [...c.querySelectorAll('td span')].find((e) => /2\s*篇/.test(e.textContent ?? ''));
    expect(cell, '讲解篇数没渲染出来').toBeDefined();
    expect((cell as HTMLElement).style.color).toContain('--blue');
  });

  it('没有讲解时给一个破折号，不是红色的 0', async () => {
    stub.entries = [{ ...entry('click'), noteCount: 0 }];
    const c = await draw();
    expect(c.querySelector('.ant-badge-count')).toBeNull();
    expect(c.textContent).toContain('—');
  });

  it('删除平时不亮红，靠 danger-link 交给 CSS 在 hover / 键盘落上去才变红', async () => {
    stub.entries = [entry('click')];
    const c = await draw();
    const del = [...c.querySelectorAll('button')].find((b) => b.textContent === '删除');
    expect(del, '删除按钮没渲染').toBeDefined();
    expect(del!.className).toContain('danger-link');
    // 不能再用 antd 的 danger 文字色（那是一直亮着的）
    expect(del!.className).not.toContain('ant-typography-danger');
  });

  // 它一度是 `<a className="danger-link">删除</a>`——没有 href 的 <a> 浏览器不给焦点，
  // 实测 .focus() 之后 activeElement 还是 body、回车唤不出确认框，整张表的删除只有
  // 鼠标点得动。而这个动作删的是词条连同它的复习进度。
  // CSS 里那条 .danger-link:focus-visible 当时也就一直是死规则。
  it('删除必须键盘够得着', async () => {
    stub.entries = [entry('click')];
    const c = await draw();
    const del = [...c.querySelectorAll('button')].find((b) => b.textContent === '删除')!;
    del.focus();
    expect(document.activeElement, '删除聚不了焦，键盘用户完全够不到它').toBe(del);
  });
});

/**
 * 好几处写着"去问 AI"，手边没有 AI 的人会以为缺了这一环工具就不完整。
 * 实际上查词、真人音、逐音素评测、复习全是本地的——这句话必须在大门口说一次。
 */
describe('必须说清没有 AI 也能用', () => {
  it('空库时的「怎么用」要交代这件事', async () => {
    stub.entries = [];
    const c = await draw();
    expect(c.textContent).toMatch(/不需要 AI|不用 AI/);
  });

  it('第一屏不许出现 notes/ 这种开发者叫法', async () => {
    // 侧栏管它叫「发音笔记」，而「怎么用」里写的是 notes/——同一样东西两个名字，
    // 新用户先撞见的还是他不认识的那个，而且被排版成代码块，像是要去哪儿找的东西。
    // 这是模拟新用户走一遍时看出来的。
    stub.entries = [];
    const c = await draw();
    expect(c.textContent).not.toContain('notes/');
    // 换成了界面里的叫法，而且点得过去
    expect(c.textContent).toContain('发音笔记');
    expect([...c.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('/notes');
  });

  it('中文之间不许出现空格豁口', async () => {
    // JSX 把「换行 + 缩进」折成一个空格。中文文案跨行写的话，屏幕上就是
    // 「复习都在本机跑。 它只多做一层」「哪个发对了、 哪个发成了别的音」这种豁口。
    // 类型检查看不出来、纯函数测试也拦不住，是模拟新用户看第一屏时才发现的。
    stub.entries = [];
    const text = (await draw()).textContent ?? '';
    // 汉字/中文标点 + **半角**空格 + 汉字。
    // 只盯半角空格：全角空格「　」(U+3000) 是故意的排版——步骤标题和正文之间就用它分隔。
    const gaps = text.match(/[一-龥，。、：；？！「」（）] [一-龥]/g) ?? [];
    expect(gaps, `出现了空格豁口：${gaps.join(' / ')}`).toEqual([]);
  });

  it('「怎么用」里要能走到「中文母语者最该注意的」那份清单', async () => {
    stub.entries = [];
    const c = await draw();
    const links = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/phonemes');
  });
});

describe('主控件得说得出自己是什么', () => {
  // placeholder 不是名字：一开始打字它就没了。这是整个应用的入口控件。
  it('查词框有可访问名', async () => {
    const c = await draw();
    const input = c.querySelector('input[type="search"], input.ant-input');
    expect(input, '没找到查词框').not.toBeNull();
    const name = input!.getAttribute('aria-label')
      ?? (input!.getAttribute('aria-labelledby') && c.querySelector(`#${input!.getAttribute('aria-labelledby')}`)?.textContent)
      ?? (input as HTMLInputElement).labels?.[0]?.textContent
      ?? '';
    expect(name.trim(), '查词框只有 placeholder，没有名字').not.toBe('');
  });
});

/**
 * 写死在文案里的数字，必须跟它描述的那份东西对得上。
 *
 * 现在有两处：README 说「输入框正下方就有**六个**起步词」，HowItWorks 说
 * 「中文母语者最该注意的**六条**」。两个数都不在它们描述的文件里——
 * 起步词是 HomePage 的 STARTERS，那六条在 PhonemesPage 上。
 * 加一条第七个起步词、或者在音素页多列一项，这两句话当场变成假的，
 * 而类型检查和现有测试一个都不会红。
 *
 * 这个仓库被同一形状咬过好几次（README 的 41 个音、17 篇笔记、停止提示那句原话）。
 * 判据是"数字对不对得上"，不锁具体措辞——中文数字换成阿拉伯数字也照样查。
 */
describe('文案里写死的数字，跟它数的东西对得上', () => {
  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const root = join(import.meta.dirname, '..', '..', '..');
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  it('README 说的起步词个数 = STARTERS 的实际条数', () => {
    const n = (read('web/src/pages/HomePage.tsx').match(/\{ word: '/g) ?? []).length;
    expect(n, '一个起步词都没数到，这条用例是空的').toBeGreaterThan(2);
    const m = /(\d+|[零一二三四五六七八九十])个起步词/.exec(read('README.md'));
    expect(m, 'README 不再提起步词个数了，这条可以撤').not.toBeNull();
    const said = CN.indexOf(m![1]) >= 0 ? CN.indexOf(m![1]) : Number(m![1]);
    expect(said, `README 说 ${m![1]} 个，实际 ${n} 个`).toBe(n);
  });

  it('「最该注意的六条」= 音素页那份清单的实际条数', () => {
    // 这一块从 <div>+<span> 改成了 <details>+<summary>（录过音之后默认收起）
    const list = /最该注意的\s*<\/summary>\s*<ol[\s\S]*?<\/ol>/.exec(read('web/src/pages/PhonemesPage.tsx'));
    expect(list, '音素页那份清单找不到了——结构变了就得改这条').not.toBeNull();
    const n = (list![0].match(/<li>/g) ?? []).length;
    expect(n, '一条都没数到').toBeGreaterThan(2);
    const m = /最该注意的(\d+|[零一二三四五六七八九十])条/.exec(read('web/src/components/HowItWorks.tsx'));
    expect(m, '首页不再说条数了，这条可以撤').not.toBeNull();
    const said = CN.indexOf(m![1]) >= 0 ? CN.indexOf(m![1]) : Number(m![1]);
    expect(said, `首页说 ${m![1]} 条，音素页实际 ${n} 条`).toBe(n);
  });
});
