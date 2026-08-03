import { message } from 'antd';

// HTMLMediaElement.play() 返回的 Promise，在播放真正开始之前被 pause()、或者元素被从
// 文档里移除（React 卸载就会），会以 AbortError reject——"The play() request was
// interrupted by a call to pause()"。那不是播放失败，只是被打断了。
//
// 这个判断必须共享，不能各组件自己写一遍：Recorder 的 A/B 对比和 AudioPlayer 的播放按钮
// 是同一个失败模式，而 AudioPlayer 那边后果更重——它的 catch 除了弹红字还会退到
// speechSynthesis，而语音合成是全局的、组件卸载也停不下来，于是评分切到下一张卡片之后，
// 上一个词还在被念出来。
function isPlayAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** 给 `audio.play().catch(...)` 用：被打断就静默忽略，真失败才提示（并执行可选的兜底）。 */
export function onPlayFailure(msg: string, fallback?: () => void) {
  return (e: unknown) => {
    if (isPlayAbort(e)) return;
    message.error(msg);
    fallback?.();
  };
}
