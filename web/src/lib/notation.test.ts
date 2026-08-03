import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { phonemic, phonetic, SEVERITY_LABEL } from './notation';

// 这一对记号对应这个工具最核心的区分：/目标/ 是这个词是什么，[你发的] 是你实际发出了什么。
// 之前两边都用斜线、还写成 `/n aɪ t/`——斜线里加空格本身不是合法记法，
// 而且把"标准"和"你的"混成一类。
describe('IPA 记法', () => {
  it('音位用斜线，语音实现用方括号', () => {
    expect(phonemic('ˈnaɪt')).toBe('/ˈnaɪt/');
    expect(phonetic('naɪt')).toBe('[naɪt]');
  });

  it('数组连写，不加空格', () => {
    // `/n aɪ t/` 读起来是三个独立音素，不是一个词
    expect(phonemic(['n', 'aɪ', 't'])).toBe('/naɪt/');
    expect(phonetic(['n', 'aɪ', 't'])).toBe('[naɪt]');
  });

  it('单个音素也走同一套', () => {
    expect(phonemic('θ')).toBe('/θ/');
    expect(phonetic('s')).toBe('[s]');
  });

  it('空输入给出空记号，不崩、不出现 undefined', () => {
    expect(phonemic([])).toBe('//');
    expect(phonetic([])).toBe('[]');
    expect(phonemic('')).toBe('//');
  });
});

/**
 * 发音档案的模板里**引用了界面上的两个档位名**。
 *
 * 这类跨文件的原话拷贝会烂，而且是静默地烂——实测抓到过一次：模板写着「资料」，
 * 而界面上那一档早就叫「素材库」了。这份模板是新用户第一次启动时铺下来的那一份，
 * 也是 AI 每次会话都要读的，写错等于对着两边都说了假话。
 *
 * 消灭不了这份拷贝（模板是 markdown，取不到常量），那就让它对不上时会红。
 * 同一套做法见 SettingsPage.test.tsx —— 它去读 server/src/index.ts 的源码比对。
 */
describe('发音档案模板引用的界面文案', () => {
  const template = readFileSync(join(__dirname, '../../../发音档案.template.md'), 'utf8');

  it('引用的「录音里反复出现」跟界面上的是同一个词', () => {
    expect(SEVERITY_LABEL.confirmed, '前提：这个档位有名字').toBeTruthy();
    expect(template).toContain(SEVERITY_LABEL.confirmed!);
  });

  it('引用的「素材库」跟笔记页上的是同一个词', () => {
    // 另一档没有常量（它是"没有标签"那一档），名字只写在笔记页那个分组标题里。
    // **必须从源码里抠出真正渲染的那个词**，不能在测试里列候选：
    // 第一版写成 /「(素材库|资料)」/ 然后去 NotesPage 里找，结果「资料」在那一页
    // 作为普通行文出现了三次（"只是可以翻的资料"），断言必然通过——变异活了下来。
    const notesPage = readFileSync(join(__dirname, '../pages/NotesPage.tsx'), 'utf8');
    const label = notesPage.match(/(\S+) · \{material\.length\} 篇/)?.[1];
    expect(label, '笔记页那个分组标题被改写了，这条断言跟着失效').toBeTruthy();
    expect(template, `界面上那一档叫「${label}」，模板里写的不是这个`).toContain(label!);
  });
});
