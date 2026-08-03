import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import NoteHits from './NoteHits';
import type { EntryDetail } from '../types';

/**
 * 词条页上「这个词涉及的讲解」。
 *
 * 这里守两件事，都来自实际使用中的反馈：
 *
 * 一、**不摊全文。** 原来每篇都把 markdown 整个铺出来，dopamine detox 那一页光笔记
 *     正文就 3942 字，其中 1110 字的 l-vs-n 只是因为这个词里有个 /n/ 就跟了上来，
 *     人还没开口念呢。一屏读不完的东西等于没写。
 *
 * 二、**没在你身上出现过的，不许盖章。** 只有 confirmed 才挂标签。
 *     给一份资料盖个「待观察」，等于把它摆成了对你的判定。
 *     断言**不锁那个标签叫什么**——它已经从「你确认过的短板」改成「录音里反复出现」
 *     一次了，锁字面量的话每次措辞调整都假红，然后被 skip 掉，最后等于没有。
 *     锁的是关系：confirmed 比另外两档多出一块东西，而那块东西只有它有。
 */

function note(over: Partial<EntryDetail['notes'][number]> = {}): EntryDetail['notes'][number] {
  return {
    id: 'l-vs-n',
    title: 'l / n 不分（边音 vs 鼻音）',
    severity: 'info',
    matched: ['phoneme:n'],
    markdown: '# 标题\n\n这是一段**很长**的正文，长到不该整个铺在词条页上。'.repeat(20),
    // 默认「跟这个词有关」。relevant 由服务端算，判据带方向、而且**只算这一个词**：
    // 这篇教得了一处你**在这个词上**真犯过的错。
    // 原来是全局的——你在 thin 上错过 ɪ→i，click 里有个 /ɪ/，长短元音那篇就被
    // 摆进 click 的「这个词的讲解」，而你在 click 上从没错过 ɪ。
    relevant: true,
    // 是哪几处错把它拉到外面来的。折叠里的、以及讲词的笔记都是空数组
    becauseOf: ['l→n'],
    ...over,
  };
}

describe('词条页的讲解列表', () => {
  it('只给标题和入口，不把笔记正文摊在词条页上', () => {
    const { container } = render(
      <MemoryRouter><NoteHits notes={[note({ severity: 'confirmed' })]} /></MemoryRouter>,
    );
    // 标题在、能点进去
    const link = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/notes/l-vs-n');
    expect(link, '没给通往笔记的入口').toBeDefined();
    // 正文不在
    expect(container.textContent).not.toContain('这是一段');
    // 渲染出来的文字量得是"一行标题"的量级，不是一篇文章
    expect((container.textContent ?? '').length).toBeLessThan(120);
  });

  // 不说的话，一个讲 /l/ 的东西跑到 dopamine 页上看着莫名其妙。
  // 两栏的理由**不是同一件事**，各说各的：
  //   摆在外面的 → 你在这个词上错过什么（那才是它出来的原因）
  //   收在折叠里 → 只是这个词里有那个音
  // 原来两边共用一句「因为这个词里有 l」，于是一篇因为"你把 l 念成了 n"
  // 而摆在外面的笔记，底下写的却是匹配规则——说的不是同一件事。
  it('摆在外面的说：你在这个词上错过什么', () => {
    const { container } = render(
      <MemoryRouter><NoteHits notes={[note({ severity: 'confirmed', becauseOf: ['l→n'] })]} /></MemoryRouter>,
    );
    expect(container.textContent).toMatch(/错过/);
    expect(container.textContent, '没说出是哪一处错').toContain('l→n');
  });

  it('收在折叠里的说：只是这个词里有那个音', () => {
    const { container } = render(
      <MemoryRouter><NoteHits notes={[note({ relevant: false, becauseOf: [] })]} /></MemoryRouter>,
    );
    expect(container.textContent).toMatch(/因为这个词里有|专门讲这个词/);
  });

  it('**不许印笔记的原始 trigger 语法**——那是写笔记的人跟分析器之间的约定', () => {
    // 两栏都查：换成人话这件事不能只做一半
    for (const n of [note({ becauseOf: ['l→n'] }), note({ relevant: false, becauseOf: [] })]) {
      const { container } = render(<MemoryRouter><NoteHits notes={[n]} /></MemoryRouter>);
      const t = container.textContent ?? '';
      expect(t, '把 phoneme: 这种内部标签印出来了').not.toMatch(/phoneme:|cluster-onset:|cluster-coda:|word:/);
    }
    // 折叠那栏换成人话之后，那个音本身还是要说出来的
    const { container } = render(
      <MemoryRouter><NoteHits notes={[note({ relevant: false, becauseOf: [] })]} /></MemoryRouter>,
    );
    expect(container.textContent).toContain('/n/');
  });

  /**
   * 跟你有关的排前面，其余收起来。
   *
   * 匹配规则本身是对的——light 有 /l/ 就该能看到 l/n 那篇——但笔记越攒越多，
   * 每个含 /n/ 的词都会挂上 l-vs-n 和 n-vs-ng，列表无限长。
   * 一个词后面拖一长串笔记，完全看不过来。
   * 而音素条上点任意一个音本来就能到那个音的页面，这一块不必再当一份音素笔记索引。
   */
  it('你还没在这个词上错过的，收进折叠里', () => {
    const { container } = render(
      <MemoryRouter>
        <NoteHits notes={[
          note({ id: 'mine', title: '你错过的', relevant: true }),
          note({ id: 'ref', title: '只是碰巧含这个音', relevant: false }),
        ]} />
      </MemoryRouter>,
    );
    const details = container.querySelector('details');
    expect(details, '没有折叠区').not.toBeNull();
    // 跟你有关的在折叠**外面**
    expect(details!.textContent).not.toContain('你错过的');
    expect(details!.textContent).toContain('只是碰巧含这个音');
    // 但收起来不等于藏起来——要说清里面有几篇、为什么在里面
    expect(details!.querySelector('summary')!.textContent).toMatch(/1 篇|还没.*错过/);
  });

  it('讲这个词自己的笔记永远在外面，哪怕你还没错过', () => {
    // words: 范围的笔记讲的是这个词自己的坑，不是"碰巧含某个音"
    const { container } = render(
      <MemoryRouter>
        <NoteHits notes={[note({ id: 'w', severity: 'info', relevant: true, matched: ['word:dopamine detox'] })]} />
      </MemoryRouter>,
    );
    expect(container.querySelector('details')).toBeNull();
  });

  it('全都跟你有关时，不出现折叠区', () => {
    const { container } = render(
      <MemoryRouter><NoteHits notes={[note({ severity: 'confirmed' })]} /></MemoryRouter>,
    );
    expect(container.querySelector('details')).toBeNull();
  });

  it('只有反复出现过的才盖章，另外两档一个字都不加', () => {
    const draw = (severity: 'confirmed' | 'watch' | 'info') => render(
      <MemoryRouter><NoteHits notes={[note({ severity })]} /></MemoryRouter>,
    ).container.textContent ?? '';

    const mine = draw('confirmed');
    const watch = draw('watch');
    const info = draw('info');

    // confirmed 多出来的那一块就是标签本身。不锁它叫什么，只要求它存在、
    // 而且**只有 confirmed 有**——盖章是对这个人的判定，没证据就不许盖。
    expect(mine.length, 'confirmed 没多出任何标记').toBeGreaterThan(watch.length);
    const badge = mine.replace(watch, '').trim();
    expect(badge, '多出来的是空的').not.toBe('');
    expect(watch, `watch 也被盖章了：${badge}`).not.toContain(badge);
    expect(info, `info 也被盖章了：${badge}`).not.toContain(badge);
    // 另外两档彼此也不该有差别——「待观察」曾经是个独立层级，现在不是了
    expect(watch).toBe(info);
  });
});
