import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { PhonemeDetail } from '../types';

/**
 * 音素页的「模型判得准吗」提示。
 *
 * 背景是一次实测：模型听真人录音，
 * 辅音 41/42 对，元音只有 15/22、低元音 6/10，错法还定向（往 /æ/ 拽）。
 * 这条提示的存在理由：工具报"元音发错"时，用户得知道这话要打折听、该先自检。
 *
 * 守两件接线的事，都是"字段取值必须改变渲染结果"那一类：
 *   一、kind 决定提示的有无——元音有、辅音没有（标异常不标常态）；
 *   二、ə/ʌ、ɚ/ɝ 这四个音的页面要多说一句"这一对之间一律不判"（重音维度测不了），
 *       其余元音不说。
 * 按仓库规矩不锁具体文案，断言落在概念词上。
 */

const stub = vi.hoisted(() => ({ detail: null as PhonemeDetail | null }));

vi.mock('../api', () => ({
  api: { phoneme: () => (stub.detail ? Promise.resolve(stub.detail) : Promise.reject(new Error('404'))) },
}));

const { default: PhonemePage } = await import('./PhonemePage');

function vowel(ipa: string): PhonemeDetail {
  return {
    phone: { kind: 'vowel', ipa, height: 0.5, back: 0.5, rounded: false, glideTo: null, howTo: '嘴放松。' },
    places: [], manners: {}, examples: [], notes: [],
  };
}

function consonant(ipa: string): PhonemeDetail {
  return {
    phone: { kind: 'consonant', ipa, place: 'velar', manner: 'stop', voiced: false, nasal: false, howTo: '舌根顶软腭。' },
    places: [{ id: 'velar', label: '软腭' }], manners: { stop: '塞音' }, examples: [], notes: [],
  };
}

async function draw(detail: PhonemeDetail) {
  stub.detail = detail;
  const { container } = render(
    <MemoryRouter initialEntries={[`/phoneme/${encodeURIComponent(detail.phone.ipa)}`]}>
      <Routes><Route path="/phoneme/:ipa" element={<PhonemePage />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(container.textContent).toContain('怎么发'));
  return container.textContent ?? '';
}

describe('音素页的判定可信度提示', () => {
  // 概念词只用「判得/判定/镜子」——「自检」不行，它出现在每一页"笔记为空"的
  // 固定文案里（"带自检法和对比训练"），拿它当探针会把辅音页也测成阳性。踩过。
  it('元音页要说"模型对这个音判得不准、先对镜子确认"', async () => {
    const text = await draw(vowel('ɑ'));
    expect(text, '元音页没提判定可信度').toMatch(/判得|判定/);
    expect(text, '没让用户对镜子确认').toContain('镜子');
  });

  it('辅音页不挂这条——41/42 的判定不用打折，标异常不标常态', async () => {
    const text = await draw(consonant('k'));
    expect(text).not.toMatch(/判得|判定/);
    expect(text).not.toContain('镜子');
  });

  it('ə 的页面要说清：它跟 ʌ 之间一律不判（重音测不了）', async () => {
    const text = await draw(vowel('ə'));
    expect(text, '没提重音这个测不了的维度').toContain('重音');
    expect(text, '没点出配对的那个音').toContain('ʌ');
  });

  it('普通元音不提"一律不判"那句——那句只属于重音对', async () => {
    const text = await draw(vowel('ɑ'));
    expect(text).not.toContain('重音');
  });
});
