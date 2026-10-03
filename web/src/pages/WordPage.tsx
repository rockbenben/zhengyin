import { useEffect, useState } from 'react';
import { useTitle } from '../lib/useTitle';
import { Link, useParams } from 'react-router';
import { Button, Space, Typography } from 'antd';
import { api, isOffline } from '../api';
import type { EntryDetail } from '../types';
import AudioPlayer from '../components/AudioPlayer';
import AsrStatus from '../components/AsrStatus';
import PhonemeBar from '../components/PhonemeBar';
import NoteHits from '../components/NoteHits';
import Recorder from '../components/Recorder';
import StarButton from '../components/StarButton';
import Offline from '../components/Offline';
import { wordIpa } from '../lib/notation';
import PageResult, { LoadFailed } from '../components/PageResult';

// 词条页：查过一个词/短语之后落地的详情页。只渲染服务端已经算好的东西，
// 页面本身不产出任何讲解内容——服务端没有这个词条时给一个友好的空状态，而不是报错。
//
// 版式按套印的版口来：左侧留出套准标记，词条大字咬着版口起排。
export default function WordPage() {
  const { text } = useParams<{ text: string }>();
  useTitle(text);
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [error, setError] = useState<null | 'missing' | 'offline' | 'failed'>(null);
  /** 缺词时服务端给的「在不在词典」。null = 服务端没给（旧服务），按在的话说 */
  const [inDictionary, setInDictionary] = useState<boolean | null>(null);
  const [starred, setStarred] = useState(false);

  useEffect(() => {
    setEntry(null);
    setError(null);
    setInDictionary(null);
    if (!text) return;
    api.getEntry(text)
      .then((e) => { setEntry(e); setStarred(e.review?.starred ?? false); })
      .catch((e) => {
        if (isOffline(e)) { setError('offline'); return; }
        // 「库里还没有」是一句关于库的断言，只有 404 撑得起它。
        // 500/超时也走这一屏的话，服务在跑但崩了（或 dev 下服务根本没起——
        // 代理把它变成 500）时，页面会请人回首页建一个建不出来的词。
        // api.ts 开头记的那族事故修剩的正是这半条。
        const nd = (e as Error & { notFound?: { inDictionary?: boolean } }).notFound;
        if (!nd) { setError('failed'); return; }
        setError('missing');
        setInDictionary(nd.inDictionary ?? null);
      });
  }, [text]);

  if (error === 'offline') return <Offline />;
  if (error === 'failed') return <LoadFailed what="这个词的详情" />;
  if (error) {
    // ── 空状态要给**他自己就能做**的那一步 ──
    //
    // 原来只写「去问 AI，讲解后会自动出现在这里」——那是这个功能刚做出来时
    // 的实情，现在已经不是了：首页那个输入框按「查这个词」就能建，音标、真人录音、
    // 音素条、评测全自动配好。把唯一的出路指向另一个软件，等于让人干等。
    //
    // 两件事分开说：**词条**他自己就能建，**讲解**才需要 AI 写。
    // 按钮上的字跟首页那个按钮一字不差——同一个动作在两处叫两个名字，人得重新认一遍。
    //
    // 但「就能建」这句**只在词典里有这个词时成立**：查不到的词（专有名词、缩写、
    // 生造词）回首页按了同样被退回来。服务端在 404 里给了 inDictionary，按它分叉；
    // 字段缺失（旧服务）时不猜，按原来那句说。
    return (
      <PageResult
        slug="找不到"
        title="库里还没有这个词"
        extra={<Link to="/"><Button type="primary">回首页查这个词</Button></Link>}
      >
        {inDictionary === false ? (
          <>
            这个词不在词典里（专有名词、缩写、生造词都这样）——回首页按「查这个词」
            也建不出它的音标。让 AI 帮你录一个：给它能读写文件的那种 AI 说
            「把这个词录进正音，音标是 /…/」，它写完会自动出现在这一页。
          </>
        ) : (
          <>
            回首页按「查这个词」就能建，音标、真人录音、音素条、评测都会自动配好。
            <br />
            「为什么会错」那种讲解要去问 AI，它写完会自动出现在这一页。
          </>
        )}
      </PageResult>
    );
  }
  if (!entry) return null;

  // 音素→笔记的联动靠这个集合：把这个词条命中的每条笔记的 matched（笔记 trigger
  // 里真正跟这个词条搭上的那部分）拍平成一个 tag 并集，PhonemeBar 逐音素跟它求交。
  const hitTags = new Set(entry.notes.flatMap((n) => n.matched));
  const phrase = entry.words.length > 1;

  return (
    <Space direction="vertical" size={40} style={{ width: '100%' }}>
      <header className="word-head">
        <span className="reg-mark" aria-hidden="true"><i /></span>
        <div>
          <span className="slug">{phrase ? '短语' : '单词'}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, marginTop: 8 }}>
            <h1 className="display">{entry.text}</h1>
            <div style={{ paddingBottom: 6 }}>
              <StarButton text={entry.text} starred={starred} onChange={setStarred} />
            </div>
          </div>
          {entry.phraseAudio && (
            <div style={{ marginTop: 16 }}>
              <AudioPlayer src={entry.phraseAudio.url} label={entry.text} />
            </div>
          )}
        </div>
      </header>

      {/* 识别服务的状态是**整页一份**的事实（原来每个音节各摊一份同样的三行字） */}
      <AsrStatus />

      {entry.words.map((w, i) => {
        const audio = entry.audio.find((a) => a.word === w.word);
        return (
          <section
            key={w.word}
            style={{
              borderTop: phrase ? '1px solid var(--rule)' : undefined,
              paddingTop: phrase ? 26 : 0,
            }}
          >
            {phrase && (
              <Typography.Title level={3} className="display" style={{ fontSize: 30, marginBottom: 10 }}>
                {w.word}
              </Typography.Title>
            )}

            <Space wrap size={16} align="center" style={{ marginBottom: 18 }}>
              <span className="ipa" style={{ fontSize: 24, letterSpacing: '.03em' }}>
                {wordIpa(w)}
              </span>
              <AudioPlayer src={audio?.url ?? null} label={w.word} />
              {audio && (
                <span
                  className="slug"
                  style={{ border: '1px solid var(--rule)', padding: '4px 8px', letterSpacing: '.1em' }}
                >
                  {audio.source === 'mw' ? '真人录音 Merriam-Webster' : '合成语音'}
                </span>
              )}
            </Space>

            {w.found && (
              <div style={{ marginBottom: 26 }}>
                <PhonemeBar
                  word={w}
                  hitTags={hitTags}
                  onTagClick={(tag) => {
                    const hit = entry.notes.find((n) => n.matched.includes(tag));
                    if (hit) {
                      document.getElementById(`note-${hit.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                  }}
                />
              </div>
            )}

            {/* 词典里查不到音素的词，评测接口会直接 400——别给按钮，那是条死路。
                这类词（专有名词、缩写）目前只能听音频和 A/B 对比。 */}
            {/* 短语是逐词录的，而那段操作说明每个词都摊一遍——两个词就读两遍同样的五行。
                只有第一个给完整版，后面的留一句。 */}
            {w.found ? (
              <Recorder
                target={w.word}
                entry={entry.text}
                referenceUrl={audio?.url ?? entry.phraseAudio?.url ?? null}
                hint={i === 0 ? 'full' : 'brief'}
              />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                词典里查不到这个词，评测用不了。可以听上面的音频跟着念。
              </Typography.Text>
            )}
          </section>
        );
      })}

      <NoteHits notes={entry.notes} />
    </Space>
  );
}
