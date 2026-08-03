import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { WordAnalysis } from '../types';

vi.mock('../lib/articulation', async () => {
  const actual = await vi.importActual<typeof import('../lib/articulation')>('../lib/articulation');
  return { ...actual, articulationTable: () => Promise.resolve({ places: [], manners: {}, phones: [] }) };
});

const { default: PhonemeBar } = await import('./PhonemeBar');

/**
 * 音素条上的重音标注。
 *
 * 换掉的是「重音 / 第 2 节」那套：「第 2 节」是**序号不是属性**，而三音节词会排成
 * 「第 1 节 · 重音 · 第 3 节」——两个非重读音节同一类却写着两种字。
 * 更要紧的是**「轻」以前根本没有名字**，而弱读音节念成满元音正是使用者最大的元音问题。
 *
 * 这里守的核心是一条"不许说假话"：dopamine 是 1-0-2，词尾 -mine 是次重音、
 * 元音满的 /miːn/。按"非主重音即轻读"画，屏幕上就多了一句假的。
 */

// dopamine /ˈdoʊpəˌmiːn/ —— 主重音、轻读、次重音各一个，三级齐全
function dopamine(over: Partial<WordAnalysis> = {}): WordAnalysis {
  return {
    word: 'dopamine', found: true,
    arpabet: ['D', 'OW1', 'P', 'AH0', 'M', 'IY2', 'N'],
    ipa: 'ˈdoʊpəˌmin', tags: [],
    phoneIpa: ['d', 'oʊ', 'p', 'ə', 'm', 'i', 'n'],
    phoneTags: [[], [], [], [], [], [], []],
    syllables: [[0, 1], [2, 3], [4, 5, 6]],
    syllableStress: [1, 0, 2],
    ...over,
  };
}

async function draw(word: WordAnalysis) {
  const { container } = render(
    <MemoryRouter><PhonemeBar word={word} hitTags={new Set()} onTagClick={() => {}} /></MemoryRouter>,
  );
  await waitFor(() => expect(container.textContent).toContain('点音标'));
  return container;
}

/** 每一节标出来的级别，按音节顺序 */
const levels = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-stress]')].map((e) => e.getAttribute('data-stress'));

/**
 * 每一节圆点的**填充**：实心=读实，空心=弱化。
 * 断言要落在这里而不是 data-stress——属性对了、画反了的变异会从属性断言底下溜过去。
 */
const fills = (c: HTMLElement) =>
  [...c.querySelectorAll('[data-stress]')].map(
    (e) => e.querySelector<HTMLElement>('span')?.style.background || 'none');

/**
 * 点开一个音素格之后那块面板。
 *
 * 这里守的是**链接的地址真的拼出来了**。原来这条链接外面裹着一层 `openIpa &&`，
 * 理由写着"旧词条没有 phoneIpa，拼出来会是 /phoneme/undefined"。
 * 旧词条那条路已经关了（phoneIpa 改成必填），那层保护跟着删掉——
 * 但删掉之后这段就没有任何用例走过了：上面六条全是渲染重音，一条都没点开面板。
 *
 * 改过又没人验的代码，等于把"我认为它跑得到"当成了事实。所以补这一条。
 */
describe('点开一个音素', () => {
  it('给得出这个音的音素页地址，不是 /phoneme/undefined', async () => {
    const c = await draw(dopamine());
    const cells = [...c.querySelectorAll('button')];
    expect(cells.length, '一个可点的音素格都没有').toBeGreaterThan(0);
    fireEvent.click(cells[0]);                     // dopamine 的第一个音是 /d/
    const link = await waitFor(() => {
      const a = [...c.querySelectorAll('a')].find((x) => x.getAttribute('href')?.startsWith('/phoneme/'));
      expect(a, '点开之后没有音素页链接').toBeTruthy();
      return a!;
    });
    expect(link.getAttribute('href'), '拼出了 undefined —— openIpa 没取到').toBe('/phoneme/d');
    expect(c.textContent).not.toContain('undefined');
  });
});

describe('音素条的重音标注', () => {
  it('三级各就各位：主重音 / 轻读 / 次重音', async () => {
    expect(levels(await draw(dopamine()))).toEqual(['1', '0', '2']);
  });

  it('次重音要画成**读实的**，跟轻读分在两边', async () => {
    // 这条是整节的核心，而且断言必须落在**画出来的样子**上：
    // 光看 data-stress 的话，把次重音渲染成空心圈的变异照样活着（实测活过一次）。
    // -mine 读 /miːn/，元音是满的，跟中间那个 ə 完全不是一回事。
    const f = fills(await draw(dopamine()));
    expect(f[2], '词尾次重音被画成空心（=轻读）了').toBe(f[0]);   // 跟主重音同一类
    expect(f[1], '轻读跟重读画得一样').not.toBe(f[0]);
  });

  it('轻读那一节要有名字——它是弱化练习的对象', async () => {
    // 以前这一节叫「第 2 节」，是个序号，什么都没说
    expect((await draw(dopamine())).textContent).toContain('轻');
  });

  it('三级在屏幕上必须长得不一样，否则标了等于没标', async () => {
    const c = await draw(dopamine());
    const marks = [...c.querySelectorAll<HTMLElement>('[data-stress]')];
    const shape = marks.map((m) => {
      const dot = m.querySelector<HTMLElement>('span');
      return `${m.style.fontWeight}/${dot?.style.width}/${dot?.style.background}`;
    });
    expect(new Set(shape).size, '三节看起来一模一样').toBe(3);
  });

  it('不再出现"第 N 节"这种序号', async () => {
    expect((await draw(dopamine())).textContent).not.toMatch(/第 \d 节/);
  });

  it('单音节词不画——只有一节，谈不上轻重', async () => {
    const c = await draw(dopamine({
      word: 'thin', arpabet: ['TH', 'IH1', 'N'], phoneIpa: ['θ', 'ɪ', 'n'],
      phoneTags: [[], [], []], syllables: [[0, 1, 2]],
      syllableStress: [1],
    }));
    expect(levels(c)).toEqual([]);
  });
});
