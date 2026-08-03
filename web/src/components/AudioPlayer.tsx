import { useEffect, useRef, useState } from 'react';
import { Button, Segmented, Space, Typography } from 'antd';
import { SoundOutlined } from '@ant-design/icons';
import { onPlayFailure } from '../lib/playback';

interface Props {
  /** 音频文件 URL；服务端音频链路（MW 真人 / edge-tts）没能拿到文件时为 null */
  src: string | null;
  /** 没有音频文件时，交给浏览器本地语音合成朗读的文本 */
  label: string;
}

const RATE_OPTIONS = [
  { label: '1.0x', value: 1 },
  { label: '0.75x', value: 0.75 },
  { label: '0.5x', value: 0.5 },
];

export default function AudioPlayer({ src, label }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [rate, setRate] = useState(1);
  const [unsupported, setUnsupported] = useState(false);
  // 这个实例当前正在朗读的那条 utterance。speechSynthesis 是全局单例，组件卸载不会停下
  // 它——复习页评完分翻到下一张，整块内容连同本组件一起卸载，上一张卡片的词会继续念到下一张卡片
  // 上，只能刷新页面才止得住。<audio> 元素没有这个问题（规范规定元素被移出文档时自动
  // 暂停），所以只需要管语音合成这一路。
  //
  // 存的是 utterance 本身而不是一个布尔量：连点两次「朗读」（比如先听一遍、觉得快，切到
  // 0.5x 再点一次）时，第一条被 cancel() 掉，但它的 end/error 事件是**之后**才作为单独的
  // 任务派发的——那时第二条已经在念了。用布尔量的话这个迟到事件会把标志清成 false，卸载
  // 时就不 cancel，于是那个本该被修掉的"念到下一张卡片上"又回来了。比对身份就不会误清。
  const speakingUtterance = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => () => {
    // 只在确实是自己起的朗读时才 cancel：speechSynthesis 是全局的，页面上同时渲染着多个
    // AudioPlayer（词条页一个词一个），无条件 cancel 会把别的实例正在念的也掐掉。
    if (speakingUtterance.current) speechSynthesis.cancel();
  }, []);

  // 服务端没有音频文件（MW/edge-tts 都没拿到）、或者有文件但播放失败（比如磁盘文件已经
  // 被删、URL 404）时，都用浏览器自带的语音合成兜底，保证用户始终能听到这个词/短语怎么
  // 读，而不是干瞪眼。
  const speakLocally = () => {
    if (!('speechSynthesis' in window)) {
      setUnsupported(true);
      return;
    }
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(label);
    utter.lang = 'en-US';
    utter.rate = rate;
    speakingUtterance.current = utter;
    // 只有"结束的正是当前这条"才清空——迟到的旧事件不许动新一条的状态
    const clearIfCurrent = () => {
      if (speakingUtterance.current === utter) speakingUtterance.current = null;
    };
    utter.onend = clearIfCurrent;
    utter.onerror = clearIfCurrent;
    speechSynthesis.speak(utter);
  };

  const play = () => {
    if (!src) {
      speakLocally();
      return;
    }
    // 慢速播放靠 <audio> 自带的 playbackRate 属性调速率，不重新请求/生成慢速音频。
    const a = audioRef.current;
    if (!a) return;
    a.playbackRate = rate;
    a.currentTime = 0;
    // a.play() 在文件缺失/404、解码失败等情况下会 reject——不接 .catch 的话播放失败时
    // 点了跟没点一样，用户什么反馈都看不到。这里提示并兜底到本机语音合成。
    // 但被打断（pause()/元素随组件卸载被移出文档）导致的 AbortError 必须排除：那不是
    // 失败，而且这里的兜底是 speechSynthesis——它是全局的，卸载也停不下来，于是"播放后
    // 立刻评分"会让上一张卡片的词在下一张卡片上被念出来，还外加一条红字。
    a.play().catch(onPlayFailure('音频播放失败，已切换为本机合成朗读', speakLocally));
  };

  return (
    <Space wrap>
      <Button icon={<SoundOutlined />} onClick={play}>
        {/* 「播放」在复习页里指代不明——播什么？说清是标准音 */}
        {src ? '听标准音' : '听合成音'}
      </Button>
      <Segmented
        size="small"
        value={rate}
        onChange={(v) => setRate(v as number)}
        options={RATE_OPTIONS}
      />
      {src && <audio ref={audioRef} src={src} preload="auto" />}
      {unsupported && (
        <Typography.Text type="danger">当前浏览器不支持语音合成，且没有音频文件</Typography.Text>
      )}
    </Space>
  );
}
