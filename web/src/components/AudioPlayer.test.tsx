import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AudioPlayer from './AudioPlayer';

/**
 * 在播态。点了「听标准音」而屏上零变化，静音的人分不出点了与没点
 * （实测：音频 currentTime 在走，两张截图逐字节相同）。
 * 这里不真放声音——jsdom 没有媒体播放，直接对 <audio> 派发 play/ended
 * 事件，测的是"事件 → 按钮文字跟着变"这根接线。
 */
describe('AudioPlayer 在播态', () => {
  it('play 事件 → 钮上写「正在播」；ended → 变回来', async () => {
    const { container } = render(<AudioPlayer src="/api/audio/book-mw.mp3" label="book" />);
    const btn = await screen.findByRole('button');
    expect(btn.textContent).toContain('听标准音');
    const audio = container.querySelector('audio')!;
    fireEvent(audio, new Event('play'));
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('正在播'));
    fireEvent(audio, new Event('ended'));
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('听标准音'));
  });

  it('pause（中途被停）也算播完，不许停在「正在播」', async () => {
    const { container } = render(<AudioPlayer src="/api/audio/book-mw.mp3" label="book" />);
    await screen.findByRole('button');
    const audio = container.querySelector('audio')!;
    fireEvent(audio, new Event('play'));
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('正在播'));
    fireEvent(audio, new Event('pause'));
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('听标准音'));
  });
});
