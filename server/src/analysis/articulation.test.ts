import { describe, it, expect } from 'vitest';
import { articulationTable, missingFromTable, missingHowTo, howToPronounce, PLACES, MANNERS } from './articulation.js';

/** 测试里查单个音素用。生产代码一律拿整张表（前端一次取回自己查），不额外开一个只有测试在用的导出 */
const at = (ipa: string) => articulationTable().find((a) => a.ipa === ipa) ?? null;

describe('发音部位表的完整性', () => {
  it('本项目会产出的每个音素都在表里', () => {
    // 漏一个音素，界面上那个音的部位尺就静静地不画了——不报错、不崩，只是永远空着。
    // 这条是那种无声失效的唯一防线。
    expect(missingFromTable()).toEqual([]);
  });

  it('每个音素都写了"怎么发"', () => {
    // 漏一个的话，那个音发错时界面只能说"还没有笔记"，等于什么都没给——
    // 而这张表存在的全部理由就是兜住这种情况。
    expect(missingHowTo()).toEqual([]);
  });

  it('"怎么发"要么给身体动作，要么直接指到一个中文里已有的音', () => {
    // AGENTS.md 的硬要求：舌尖顶哪里、气流从哪走、嘴唇展还是圆，不能写成"多听多练"那种废话。
    //
    // 但**只说"就是中文的爱"也算数**，而且往往更好：使用者本来就会发那个音，
    // 一句话就到位。硬要求每条都写解剖动作，反而逼出一堆绕圈子的描述
    // （第一版的 /aɪ/ 就是"嘴先张大、舌位放低…再把舌面抬起靠前滑向 /ɪ/"，
    // 说的其实就是"爱"）。
    const BODY = ['舌', '唇', '牙', '腭', '齿', '气', '声', '鼻', '嘴', '下巴', '喉'];
    const ANCHOR = ['中文', '就是'];
    for (const a of articulationTable()) {
      expect(a.howTo, `${a.ipa} 没有 howTo`).toBeTruthy();
      const ok = BODY.some((w) => a.howTo!.includes(w)) || ANCHOR.some((w) => a.howTo!.includes(w));
      expect(ok, `${a.ipa}：「${a.howTo}」既没有身体动作，也没指到中文里的音`).toBe(true);
    }
  });

  it('每条都短。太长就是在绕圈子，读完反而不知道要做什么', () => {
    // 这是防跑偏的护栏，**不是风格标准**：可读性测不出来，能拦住的只有"越写越长"。
    // 而且拦得很有限——试过写一句 51 字的啰嗦话，上限设 55 时它照样过。
    //
    // 2026-07-31 重校过一次：按教材给难音补了中文锚点和判别法（"落在衣和诶之间"、
    // "对镜子查牙齿碰没碰下唇"），一句话装不下"动作+锚点+差异"三件事。
    // 加厚是有意的，护栏照原来的定法重钉：实际最长 73 字（v），卡在 78，留 5 字余量。
    // 下次再撞线时先压水分，压不动再来改这个数——顺序不能反。
    for (const a of articulationTable()) {
      expect(a.howTo!.length, `${a.ipa}：${a.howTo!.length} 字，太长了`).toBeLessThanOrEqual(78);
    }
  });

  it('/n/ 的说明里带自检法——这是使用者的已确认短板，值得多给一句', () => {
    expect(howToPronounce('n')).toContain('捏住鼻子');
    expect(howToPronounce('l')).toContain('捏住鼻子');
  });

  it('表里没有的音素返回 null，不编一句', () => {
    expect(howToPronounce('ɯᵝ')).toBeNull();
  });

  it('ipa 不重复', () => {
    const ipas = articulationTable().map((a) => a.ipa);
    expect(new Set(ipas).size).toBe(ipas.length);
  });

  it('辅音的 place / manner 都是合法取值', () => {
    const places = new Set(PLACES.map((p) => p.id));
    for (const a of articulationTable()) {
      if (a.kind !== 'consonant') continue;
      expect(places.has(a.place), `${a.ipa} 的 place`).toBe(true);
      expect(Object.keys(MANNERS)).toContain(a.manner);
    }
  });

  it('元音坐标都在 0–1 之内（前端直接当百分比用）', () => {
    for (const a of articulationTable()) {
      if (a.kind !== 'vowel') continue;
      for (const [name, v] of [['height', a.height], ['back', a.back]] as const) {
        expect(v, `${a.ipa} 的 ${name}`).toBeGreaterThanOrEqual(0);
        expect(v, `${a.ipa} 的 ${name}`).toBeLessThanOrEqual(1);
      }
      if (a.glideTo) {
        expect(a.glideTo.height).toBeGreaterThanOrEqual(0);
        expect(a.glideTo.height).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('这张表要能支撑界面上的结论', () => {
  it('/n/ 和 /l/ 部位完全相同，只差鼻腔——界面据此说出"舌尖没错，错在软腭"', () => {
    const n = at('n');
    const l = at('l');
    expect(n).toMatchObject({ kind: 'consonant', place: 'alveolar', nasal: true });
    expect(l).toMatchObject({ kind: 'consonant', place: 'alveolar', nasal: false });
    // 这条断言就是那句话的依据。写反了的话界面会说"舌尖位置错了"，把人往错的方向练。
    expect((n as { place: string }).place).toBe((l as { place: string }).place);
  });

  it('/θ/ 在齿、/s/ 在齿龈——中文母语者这一对是真的部位差', () => {
    expect(at('θ')).toMatchObject({ place: 'dental' });
    expect(at('s')).toMatchObject({ place: 'alveolar' });
  });

  it('双元音带落点，单元音不带', () => {
    expect(at('aɪ')).toMatchObject({ kind: 'vowel', glideTo: { height: 0.82, back: 0.14 } });
    expect(at('i')).toMatchObject({ kind: 'vowel', glideTo: null });
  });

  it('部位按从唇到声门排列——尺子的刻度顺序靠它', () => {
    expect(PLACES.map((p) => p.id)).toEqual([
      'bilabial', 'labiodental', 'dental', 'alveolar', 'postalveolar', 'palatal', 'velar', 'glottal',
    ]);
  });

  it('表里没有的音素返回 null，不抛', () => {
    expect(at('ɯᵝ')).toBeNull();
    expect(at('')).toBeNull();
  });
});
