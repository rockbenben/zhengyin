// jsdom 里缺的那几个浏览器 API。只补 antd / React 挂载时真的会碰到的，
// 缺一个就整棵树渲染不出来，跟被测行为无关。
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// waitFor / findBy* 的默认超时是 **1000ms**，跟 vitest 的 testTimeout 是两码事——
// 把后者抬到 15 秒并不会让前者跟着变。全量并发跑五十个文件、机器上还挂着这个应用
// 本身（server + 占 1.2GB 模型的边车）时，一次 render 就可能超过一秒，
// 于是 `findByRole` 拿不到东西、报一句 "expected undefined to be defined"，
// 看起来像组件坏了，其实只是没等够。实际撞到过：ReviewPage 那条找录音按钮的用例。
configure({ asyncUtilTimeout: 5_000 });

// 每个用例之后卸载。不卸载的话下一个用例的 screen 查询会同时看到上一次的 DOM，
// "断言某段文字不出现"会莫名其妙地失败。
afterEach(cleanup);

// antd 的响应式栅格/抽屉靠它。jsdom 没有实现。
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

// antd 的 Collapse / Tooltip 等用 ResizeObserver 量尺寸
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Recorder.tsx 第 35 行的 micSupported 是**模块加载时**求值的
// （navigator.mediaDevices?.getUserMedia）。这里不补的话组件一律渲染成
// "当前浏览器不支持录音"，测不到正常状态——而 setupFiles 早于测试文件导入，
// 所以在这儿补是有效的。
// 只让"能力探测"过关；真去调它会抛，免得哪个测试不小心发起真的录音。
if (!navigator.mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => Promise.reject(new Error('测试环境不提供麦克风')),
    },
  });
}
