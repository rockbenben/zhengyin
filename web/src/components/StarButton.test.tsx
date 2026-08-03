import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

const stub = vi.hoisted(() => ({ toast: [] as string[], starred: false }));

vi.mock('../api', () => ({
  api: { star: (_t: string, on: boolean) => Promise.resolve({ starred: on }) },
}));

vi.mock('antd', async () => {
  const real = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...real,
    message: {
      success: (m: string) => stub.toast.push(m),
      error: (m: string) => stub.toast.push(m),
    },
  };
});

const { default: StarButton } = await import('./StarButton');

/**
 * 按钮名和它产生的结果，必须是**同一个词**。
 *
 * 原来按钮写「移出复习」，点完弹出的却是「已取消收藏」——而「收藏」这个说法
 * 在整个应用里根本不存在，是凭空多出来的第三个叫法。按了「移出复习」却被告知
 * 「取消收藏」，人第一反应是自己点错了。
 *
 * 所以这里不锁死具体文案，锁的是那条关系：**提示里必须含按钮上那几个字**。
 * 这样以后把「加入复习」改成别的说法，提示不跟着改就会红。
 */
beforeEach(() => { stub.toast = []; });

function draw(starred: boolean) {
  const { container } = render(
    <StarButton text="click" starred={starred} onChange={() => {}} />,
  );
  return container;
}

describe('星标按钮', () => {
  it('加入：提示用的就是按钮上那几个字', async () => {
    const c = draw(false);
    const btn = c.querySelector('button')!;
    const label = btn.textContent!.trim();
    expect(label).toBe('加入复习');
    fireEvent.click(btn);
    await waitFor(() => expect(stub.toast.length).toBe(1));
    expect(stub.toast[0], `按钮「${label}」→ 提示「${stub.toast[0]}」`).toContain(label);
  });

  it('移出：同上——不能冒出一个别处没有的说法', async () => {
    const c = draw(true);
    const btn = c.querySelector('button')!;
    const label = btn.textContent!.trim();
    expect(label).toBe('移出复习');
    fireEvent.click(btn);
    await waitFor(() => expect(stub.toast.length).toBe(1));
    expect(stub.toast[0], `按钮「${label}」→ 提示「${stub.toast[0]}」`).toContain(label);
    expect(stub.toast[0], '「收藏」这个说法整个应用里都没有').not.toMatch(/收藏/);
  });
});
