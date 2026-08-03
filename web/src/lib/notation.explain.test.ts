import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { explainTag, SEVERITY_LABEL, wordIpa } from './notation';

/**
 * explainTag 存在的唯一理由是**不许把原始 trigger 语法印给用户**
 * （「命中 phoneme:n」那种）。而它里面那张位置标签表是**手写的**，
 * 服务端 STATIC_TRIGGERS 加一个新标签，这边漏了就直接把 `final-voiced`
 * 原样印出来——正是它要防的那件事。
 *
 * 实测栽过一次：加 final-voiced 时这边就没跟上。
 */
describe('位置标签都得有人话', () => {
  it('服务端 STATIC_TRIGGERS 里的每一个，explainTag 都说得出人话', () => {
    const notes = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'server', 'src', 'notes.ts'), 'utf8',
    );
    const m = notes.match(/const STATIC_TRIGGERS = new Set\(\[([^\]]*)\]\)/);
    expect(m, '读不到 STATIC_TRIGGERS——server/src/notes.ts 换结构了？').toBeTruthy();
    const tags = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(tags.length, '一个都没解析出来').toBeGreaterThan(2);
    for (const t of tags) {
      expect(explainTag(t), `「${t}」没有人话，会把原始标签印给用户`).not.toBe(t);
    }
  });
});

describe('两处共用的那几句', () => {
  it('档次标签只有 confirmed 有——给资料盖章等于把它摆成对你的判定', () => {
    expect(SEVERITY_LABEL.confirmed).toBeTruthy();
    expect(SEVERITY_LABEL.watch).toBeUndefined();
    expect(SEVERITY_LABEL.info).toBeUndefined();
  });

  it('查得到就给音标，查不到就说出来，不摆一个空斜杠', () => {
    expect(wordIpa({ found: true, ipa: 'θɪn' })).toBe('/θɪn/');
    expect(wordIpa({ found: false, ipa: '' })).toMatch(/词典里没有/);
    // 手工给过音标的（ipaOverride）：照它显示，不覆盖成那句话
    expect(wordIpa({ found: false, ipa: '/ænˈθrɑpɪk/' })).toBe('/ænˈθrɑpɪk/');
  });
});
