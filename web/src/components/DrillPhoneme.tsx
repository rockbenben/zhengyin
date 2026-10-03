import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Space, Spin, Typography } from 'antd';
import { api, isOffline } from '../api';
import type { EntryDetail } from '../types';
import Recorder from './Recorder';
import AsrStatus from './AsrStatus';
import Offline from './Offline';

export interface Example { text: string; ipa?: string }

/**
 * 音素页上的例词：既是一份「库里含这个音的词」，也是就地开练的入口。
 *
 * ── 为什么是一块而不是两块 ──
 *
 * 这两件事一度各占一块，而它们渲染的是**同一个 examples 数组**——于是同样的词、
 * 同样的顺序，在一屏里上下叠了两遍。/n/ 有 9 个例词的时候尤其荒唐。
 *
 * 合成一块：词条名是链接（点进去看真人音和逐音素拆解），旁边一个「练」把录音器
 * 就地展开。两个动作都在，列表只有一份。
 *
 * **一次只摆一个录音器**——这跟部位尺、跟「怎么改」只摊开一篇是同一条规矩：
 * 同时铺三个，人不知道该先念哪个。
 *
 * 音频要单独取（examples 只有 text 和 ipa，没有音频地址），所以**点了才取**，
 * 不预取：41 个音素页每页预取十几个词条，换来的是绝大多数人不会点的东西。
 */
export default function DrillPhoneme({ ipa, words }: { ipa: string; words: Example[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [failed, setFailed] = useState<null | 'offline' | 'gone'>(null);

  useEffect(() => {
    setEntry(null);
    setFailed(null);
    if (!picked) return;
    let alive = true;
    api.getEntry(picked)
      .then((e) => { if (alive) setEntry(e); })
      .catch((err) => { if (alive) setFailed(isOffline(err) ? 'offline' : 'gone'); });
    return () => { alive = false; };
  }, [picked]);

  // 换音素时把选中的词清掉，否则从 /phoneme/ə 跳到 /phoneme/n 还挂着上一个音的词
  useEffect(() => { setPicked(null); }, [ipa]);

  if (words.length === 0) return null;

  return (
    <div>
      <span className="slug">库里含这个音的词 · {words.length} 个</span>
      <Typography.Text type="secondary" style={{ display: 'block', margin: '6px 0 10px', fontSize: 13 }}>
        点词名打开它的单词页，点「练」就在这儿念一遍。
      </Typography.Text>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {words.map((w) => {
          const on = picked === w.text;
          return (
            <span
              key={w.text}
              style={{
                display: 'inline-flex', alignItems: 'stretch', gap: 8,
                paddingLeft: 10,
                border: `1px solid ${on ? 'var(--blue)' : 'var(--rule)'}`,
                background: on ? 'var(--blue-soft)' : 'transparent',
              }}
            >
              {/* 撑满整格高度，点得着的就不只是那几个字母 */}
              <Link
                to={`/word/${encodeURIComponent(w.text)}`}
                style={{ fontSize: 14, display: 'flex', alignItems: 'center' }}
              >
                {w.text}
              </Link>
              {w.ipa && <span className="ipa" style={{ fontSize: 12.5, opacity: 0.65, alignSelf: 'center' }}>/{w.ipa}/</span>}
              {/* ── 「练」是这一块的动作，得**摸得着也认得出** ──
                     原来它是一个没边框、没内边距的灰字，实测 13×14px——
                     比上面那句「点「练」就在这儿念一遍」指的东西小得多，手机上按不中
                     （WCAG 2.5.8 的下限是 24×24），颜色还压在弱文字那一档，
                     跟旁边的 /θɪn/ 一样读起来像标注不像控件。
                     现在：撑满整格高度（≥24px）、蓝色（这个应用的动作色）、
                     左边一道细线把它跟词名那个链接分开——一格里两个动作，
                     得看得出边界在哪儿。 */}
              <button
                type="button"
                aria-pressed={on}
                aria-label={`在这儿练 ${w.text}`}
                onClick={() => setPicked(on ? null : w.text)}
                style={{
                  border: 0, borderLeft: `1px solid ${on ? 'var(--blue)' : 'var(--rule)'}`,
                  background: 'none', padding: '6px 10px', cursor: 'pointer',
                  font: 'inherit', fontSize: 12.5, color: 'var(--blue)',
                }}
              >
                {on ? '收起' : '练'}
              </button>
            </span>
          );
        })}
      </div>

      {picked && (
        <div style={{ marginTop: 16 }}>
          {failed === 'offline' && <Offline />}
          {failed === 'gone' && (
            <Typography.Text type="secondary">
              「{picked}」这个词取不到了，可能刚被删掉。换一个词，或者回首页重新查一次。
            </Typography.Text>
          )}
          {!failed && !entry && <Spin />}
          {entry && (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                念「{picked}」，念完看这个词的音素条里 {ipa} 那一格对没对。
              </Typography.Text>
              {/* 短语按第一个词录（Recorder 本来就是逐词的）；entry 传整条，
                  这样流水和复习卡记在真实词条上，不会落到裸词上打不开 */}
              <AsrStatus />
              <Recorder
                target={entry.words[0]?.word ?? picked}
                entry={entry.text}
                referenceUrl={entry.audio[0]?.url ?? entry.phraseAudio?.url ?? null}
                hint="brief"
              />
            </Space>
          )}
        </div>
      )}
    </div>
  );
}
