import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * 资源生命周期。这是这个前端**唯一还没有网**的高风险区，而且是类型检查天生兜不住的一类：
 * "卸载后定时器还在跑"、"卸载后麦克风还开着"、"blob URL 一直不撤"——全都编译得过。
 *
 * 后果不是显示不对，是更难查的那种：
 *   · 麦克风没停 → 浏览器标签上的红点一直亮着，用户以为在被偷录
 *   · A/B 的定时器没清 → 换了页面，300ms 后参考音突然从没有播放器的页面里响出来
 *   · AudioContext 没关 → 反复录几十次后浏览器拒绝再开（有硬上限）
 *
 * Recorder.tsx 里为这些写了大段注释（"顺序不能反"、"onended 必须一起摘掉"、
 * "AudioContext 不关会一直占着麦克风资源"），但注释不会在改坏时报警。
 *
 * 测法：把浏览器那几样有副作用的东西换成能数次数的假货，然后
 * **卸载组件，检查该释放的都释放了**。断言的是"释放动作发生了"，不是实现细节。
 */

// ── 假的浏览器 API。每个用例前重置 ──
let tracksStopped = 0;
let audioCtxClosed = 0;
let created: string[] = [];        // URL.createObjectURL 发出去的
let revoked: string[] = [];        // URL.revokeObjectURL 收回来的
let played: string[] = [];         // 真的开始播了的 src
let playedEls: HTMLMediaElement[] = [];   // 对应的元素本身——要靠它手动触发 onended
let speechCancels = 0;
let seq = 0;
let healthCalls = 0;
let gumCalls = 0;

/**
 * pronounceHealth 的桩要能在用例里换掉：轮询那两条要分别造「先假后真」和「一直假」。
 * vi.hoisted 是必须的——vi.mock 会被提到文件顶部，普通的 let 在工厂求值时还在 TDZ 里。
 */
const healthStub = vi.hoisted(() => ({ impl: () => Promise.resolve({ ok: false, uv: true }) }));

// getUserMedia 的桩：验"连点两下"要能把它挂住，制造 await 期间那个窗口。
const gumStub = vi.hoisted(() => ({ impl: (() => Promise.reject(new Error('未设置'))) as () => Promise<MediaStream> }));

// blobToClip 也要可挂住：验只有 preparing、还没到 busy 的那一帧。
const clipStub = vi.hoisted(() => ({ hold: false, release: null as null | (() => void) }));

// pronounce 的桩也要可换：验"评测在途时误点录音"必须能把它挂住不 resolve。
const pronounceStub = vi.hoisted(() => ({
  impl: () => Promise.reject(new Error('本测试不评测')) as Promise<unknown>,
}));

/** getUserMedia 给出的假流。轨道的 stop 要能数——卸载不停它就是麦克风泄漏 */
function fakeStream() {
  const track = { kind: 'audio', stop: () => { tracksStopped += 1; }, enabled: true };
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

const CLIP = { samples: new Float32Array(16000), sampleRate: 16000, peak: 0.5, noiseFloor: 0.01, snrDb: 34 };

// wav 那一层被换掉：这里测的是生命周期，不是解码。真去解码要喂真实音频数据，
// 而且 jsdom 没有 decodeAudioData。
vi.mock('../lib/wav', () => ({
  blobToClip: () => (clipStub.hold
    ? new Promise((res) => { clipStub.release = () => res(CLIP); })
    : Promise.resolve(CLIP)),
  clipToWavBlob: () => new Blob(['wav'], { type: 'audio/wav' }),
  analyze: () => CLIP,
}));

vi.mock('../api', () => ({
  api: {
    pronounceHealth: () => healthStub.impl(),   // 默认 ok:false，关掉自动评测那条支路
    getMwKey: () => Promise.resolve({ configured: true, masked: '••••1234' }),
    confusions: () => Promise.resolve({ contrasts: [] }),
    articulation: () => Promise.resolve({ places: [], manners: {}, phones: [] }),
    pronounce: () => pronounceStub.impl(),
  },
}));
vi.mock('../lib/asr', () => ({
  checkModelAvailability: () => Promise.resolve('missing'),
  contrastAll: () => Promise.resolve([]),
  resetModel: () => {},
}));

const { default: Recorder } = await import('./Recorder');
const { default: AsrStatus } = await import('./AsrStatus');
const { default: AudioPlayer } = await import('./AudioPlayer');

beforeEach(() => {
  tracksStopped = 0; audioCtxClosed = 0; created = []; revoked = []; played = []; playedEls = [];
  speechCancels = 0; seq = 0; healthCalls = 0; gumCalls = 0;
  gumStub.impl = () => Promise.resolve(fakeStream());
  healthStub.impl = () => Promise.resolve({ ok: false, uv: true });
  pronounceStub.impl = () => Promise.reject(new Error('本测试不评测'));
  clipStub.hold = false; clipStub.release = null;

  // **只换这两个静态方法，不要换掉整个 URL。** 之前用 stubGlobal('URL', {...}) 把它替成了
  // 普通对象，于是 `new URL(...)` 直接报 "URL is not a constructor"——react-router 内部就在用它，
  // 任何会重新加载模块的测试都会炸（局域网那条用例就是这么炸的）。
  // jsdom 里这两个方法不一定存在，所以先补上再 spy。
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => '' });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} });
  }
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:fake/${++seq}`;
    created.push(u);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });

  vi.stubGlobal('MediaRecorder', class {
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    state = 'inactive';
    constructor(public stream: MediaStream) {}
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  });

  vi.stubGlobal('AudioContext', class {
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createAnalyser() {
      return { fftSize: 1024, connect: () => {}, getFloatTimeDomainData: (b: Float32Array) => b.fill(0.001) };
    }
    close() { audioCtxClosed += 1; return Promise.resolve(); }
  });

  // referenceSrc() 会 fetch 参考音、剪掉静音、再 createObjectURL。
  // 不打这个桩的话 fetch 失败 → 走 catch 直接返回原 URL → **那个 blob URL 根本不会被造出来**，
  // 于是"卸载时撤销它"这条根本没被覆盖（变异测试里这一条活了下来才发现）。
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    blob: () => Promise.resolve(new Blob(['mp3'], { type: 'audio/mpeg' })),
  }));

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => { gumCalls += 1; return gumStub.impl(); } },
  });

  // jsdom 的 HTMLMediaElement.play 会抛 "Not implemented"
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.src);
    // 元素也留一份：A/B 那两个 Audio 是组件内部 new 出来的、不在 DOM 里，
    // 拿不到它就没法触发 onended，而"播完 300ms 后接参考音"的定时器只在 onended 里排。
    playedEls.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

  vi.stubGlobal('speechSynthesis', {
    speak: (u: SpeechSynthesisUtterance) => { setTimeout(() => u.onstart?.(new Event('start') as SpeechSynthesisEvent), 0); },
    cancel: () => { speechCancels += 1; },
    getVoices: () => [],
    speaking: false,
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    onstart: ((e: Event) => void) | null = null;
    onend: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    rate = 1;
    lang = 'en-US';
    constructor(public text: string) {}
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ────────────────────────────────────────────────────────────────────
describe('Recorder 卸载时必须把占住的东西都放掉', () => {
  const mount = () =>
    render(
      <MemoryRouter>
        <Recorder target="book" entry="book" referenceUrl="/api/audio/book-mw.mp3" />
      </MemoryRouter>,
    );

  /**
   * 按可见文字取按钮。名字要洗两遍才对得上（两条都是实测撞出来的）：
   *   ① antd 的 autoInsertSpace 会在两个中文字之间插空格 → 「评测」的可访问名是「评 测」
   *   ② 图标的 aria-label 会并进可访问名 → 「录音」其实是「audio 录音」、
   *      「对比播放」是「swap 对比播放」
   * 所以先去空白、再剥掉开头那串 ASCII 图标名，然后**全等**比较。
   * 不能用 includes/endsWith：「录音」是「停止录音」的子串，会同时命中两个按钮。
   */
  const btn = (label: string) =>
    screen.getByRole('button', {
      name: (n: string) => n.replace(/\s/g, '').replace(/^[a-z]+/, '') === label,
    }) as HTMLButtonElement;

  /** 点「录音」并等到流真的拿到手 */
  async function startRecording() {
    const b = btn('录音');
    await act(async () => { b.click(); });
    await waitFor(() => expect(btn('停止录音')).toBeTruthy());
  }

  /**
   * 自动停之后那一小段，录音按钮不能是活的。
   *
   * 说完自动停、自动转评测，但那个按钮瞬间变成「停止录制」，很容易误点，
   * 一点下去就等于又开了一段新录音。时序是这样的——stop() 里 setRecording(false) 是同步的，
   * 而 setClip 要等 onstop → blobToClip 解码完，所以标签在光标底下连变两次
   * （停止录音 → 录音 → 重新录），而 onClick 已经从 stop 变成了 start。
   * 点下去开一段新录音，start() 里 listenSeq.current++ 把在途的评测作废，
   * 等的结果凭空消失，屏幕上什么也不说。
   */
  it('评测在途时：录音按钮禁用，误点也不会开新录音、不会作废在途评测', async () => {
    // 把评测挂住不 resolve，制造"在途"这个中间态
    let release: (() => void) | null = null;
    pronounceStub.impl = () => new Promise((_res, rej) => { release = () => rej(new Error('停')); });
    healthStub.impl = () => Promise.resolve({ ok: true, uv: true });   // 边车在，停止后才会自动评测

    mount();
    await startRecording();
    const callsBefore = (navigator.mediaDevices.getUserMedia as unknown as { mock?: unknown }) ? 1 : 1;
    void callsBefore;

    // 自动停走的是同一条 stop()，这里用点按钮触发，时序等价
    await act(async () => { btn('停止录音').click(); });

    // 处理期：录音按钮必须是禁用的，而且标签不再是「录音」/「重新录」
    const working = await waitFor(() => {
      const b = btn('处理中');
      expect(b.disabled).toBe(true);
      return b;
    });
    // 误点一下：什么都不该发生（既没开新录音，也没抛错）
    await act(async () => { working.click(); });
    expect(btn('处理中').disabled).toBe(true);
    // 仍在处理，没有回到「停止录音」——也就是没有开出一段新录音
    expect(screen.queryByRole('button', { name: /停止录音/ })).toBeNull();
    // 屏幕上要有话交代为什么点不了
    expect(document.body.textContent).toContain('在评测');

    // 放开评测，按钮恢复
    await act(async () => { release?.(); await Promise.resolve(); });
    await waitFor(() => expect(btn('重新录').disabled).toBe(false));
  }, 15000);

  it('连点两下「录音」只开一条流 —— disabled 挡不住 await getUserMedia 那个窗口', async () => {
    // start() 是 async，setRecording(true) 排在 await getUserMedia 之后，所以从点下去
    // 到流拿到手这段时间按钮既不 recording 也不 working、仍然可点。开两条流的话
    // streamRef/rec 只存得下一个，第一条再没人停得掉——麦克风红点一直亮。
    let letGo: (() => void) | null = null;
    gumStub.impl = () => new Promise((res) => { letGo = () => res(fakeStream()); });
    mount();
    const b = btn('录音');
    await act(async () => { b.click(); b.click(); });   // 同一批事件里连点两下
    expect(gumCalls).toBe(1);
    await act(async () => { letGo?.(); });
    await waitFor(() => expect(btn('停止录音')).toBeTruthy());
    expect(gumCalls).toBe(1);
  }, 15000);

  it('录音中状态行带计时——10 秒的自动上限不许让人靠猜', async () => {
    // 「在听着 —— 念出来，停下就自动结束」说了会自动停，却没说多久算长。
    // 假麦克风下实测：从按下到上限，屏上没有任何东西在动。
    healthStub.impl = () => Promise.resolve({ ok: true, uv: true });
    mount();
    await startRecording();
    await waitFor(() => expect(document.body.textContent).toMatch(/已录 \d+\.\ds/), { timeout: 2000 });
    await act(async () => { btn('停止录音').click(); });
  }, 15000);

  it('只在解码、还没进评测的那一帧，按钮也必须已经禁用', async () => {
    // working = preparing || busy。只看 busy 的话，解码那一帧会留出一个空档，
    // 而那一帧恰好就是自动停之后误点最容易落进去的地方。
    clipStub.hold = true;
    mount();
    await startRecording();
    await act(async () => { btn('停止录音').click(); });
    // 此刻 preparing=true、busy 还没起来
    await waitFor(() => expect(btn('处理中').disabled).toBe(true));
    expect(document.body.textContent).toContain('在处理这段录音');
    await act(async () => { clipStub.release?.(); });
  }, 15000);

  it('录音中卸载 → 麦克风轨道被停掉', async () => {
    const { unmount } = mount();
    await startRecording();
    expect(tracksStopped).toBe(0);          // 还在录，当然没停
    await act(async () => { unmount(); });
    // 不停的话浏览器标签上那个红点会一直亮着，用户以为在被偷录
    expect(tracksStopped).toBeGreaterThan(0);
  });

  it('录音中卸载 → 端点检测的 AudioContext 被关掉', async () => {
    const { unmount } = mount();
    await startRecording();
    await act(async () => { unmount(); });
    // AudioContext 有硬上限，不关的话反复录几十次后浏览器就拒绝再开
    expect(audioCtxClosed).toBeGreaterThan(0);
  });

  it('A/B 播放中卸载 → 造出来的 blob URL 都被撤掉，一个不留', async () => {
    const { unmount } = mount();
    await startRecording();
    // 停止录音 → onstop → blobToClip → 有 clip 了，A/B 才可用
    await act(async () => { btn('停止录音').click(); });
    const ab = await waitFor(() => {
      const b = btn('对比播放');
      expect(b.disabled).toBe(false);
      return b;
    });
    await act(async () => { ab.click(); });
    // 两个：剪过的参考音（refWav）+ 我的录音（abObjectUrl）。
    // **断言个数**是刻意的：只要 fetch 桩哪天失灵，refWav 那个就不会被造出来，
    // 于是"撤销 refWav"这条会静默地失去覆盖——变异测试上一轮就是这么漏的。
    await waitFor(() => expect(created.length).toBe(2));

    await act(async () => { unmount(); });
    // 每个发出去的都要收回来。漏一个就是一段音频数据在内存里挂到关标签为止
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it('A/B 播放中卸载 → 参考音不许在 300ms 后自己响出来', async () => {
    const { unmount } = mount();
    await startRecording();
    await act(async () => { btn('停止录音').click(); });
    const ab = await waitFor(() => {
      const b = btn('对比播放');
      expect(b.disabled).toBe(false);
      return b;
    });
    await act(async () => { ab.click(); });
    await waitFor(() => expect(playedEls.length).toBe(1));      // 先播"我的录音"

    // **必须真的触发 onended**：那个 300ms 的定时器只在这里被排上。
    // 第一版漏了这一步，于是根本没有定时器存在，"参考音没响"是空对空——
    // 测试全绿但什么都没测到。
    await act(async () => { playedEls[0].onended?.(new Event('ended')); });

    const before = played.length;
    await act(async () => { unmount(); });                      // 就在这 300ms 的空档里卸载
    await new Promise((r) => setTimeout(r, 600));               // 等过那个 300ms

    // 定时器没清的话，参考音会从一个已经不存在的播放器里响出来
    expect(played.length).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────
/**
 * 边车健康检查的轮询。修的是一个**每次必中**的 bug：
 * 浏览器是服务一绑上端口就自动打开的，而边车还要十几秒加载 1.2GB 模型，
 * 于是页面挂载时那唯一一次健康检查必然落在"还没就绪"的窗口里——
 * 而原来只问一次，「音素识别服务没启动」就一直挂着，直到手动刷新。
 *
 * 这些提示原来长在 Recorder 里，短语页会按音节整份重复（见 AsrStatus 头注）；
 * 现在归 AsrStatus，一页一份，测试也跟着搬到这里。
 */
describe('边车没就绪时要接着问，页面自己会好', () => {
  it('先没就绪、后就绪 → 提示自己从「正在启动」变成不再出现，不用刷新', async () => {
    let ok = false;
    healthStub.impl = () => Promise.resolve({ ok, uv: true });

    render(<AsrStatus />);

    // 第一次问：没就绪 → 说"正在启动"，而不是"没启动"（后者跟事实相反）
    await waitFor(() => expect(document.body.textContent).toContain('正在加载模型'));
    expect(document.body.textContent).not.toContain('音素识别服务没起来');

    // 边车就绪
    ok = true;
    // 轮询间隔是 2s，给足时间让下一次问落地
    await waitFor(
      () => expect(document.body.textContent).not.toContain('正在加载模型'),
      { timeout: 8000 },
    );
    expect(document.body.textContent).not.toContain('音素识别服务没起来');
  }, 15000);

  it('熬过 give-up 要说「黑窗口」，不许说「终端窗口」——走到这档的人多半是双击启动的', async () => {
    healthStub.impl = () => Promise.resolve({ ok: false, uv: true });
    // 90 秒不该真等 90 秒：pollMs/giveUpMs 是测试缝
    render(<AsrStatus pollMs={20} giveUpMs={40} />);
    await waitFor(() => expect(document.body.textContent).toContain('等了一分半还没连上'));
    const t = document.body.textContent ?? '';
    expect(t, '没给可照做的下一步').toMatch(/黑窗口/);
    expect(t, '把人打发去翻终端了（uv 分支早钉过同样的理由）').not.toMatch(/终端/);
  }, 15000);

  it('卸载后不许再问 —— 否则换了页面它还在轮询，还会对已卸载的组件 setState', async () => {
    healthStub.impl = () => { healthCalls += 1; return Promise.resolve({ ok: false, uv: true }); };

    const { unmount } = render(<AsrStatus />);
    await waitFor(() => expect(healthCalls).toBeGreaterThan(0));
    await act(async () => { unmount(); });

    const after = healthCalls;
    await new Promise((r) => setTimeout(r, 2600));   // 跨过一个 2s 的轮询间隔
    expect(healthCalls).toBe(after);
  }, 15000);
});

// ────────────────────────────────────────────────────────────────────
/**
 * 局域网访问：麦克风被挡的原因要说对。
 *
 * 服务监听所有网卡，所以手机/另一台电脑用 http://192.168.x.x:30031 打开是可行的，
 * 查词、音素、笔记全正常。但 navigator.mediaDevices 只在**安全上下文**暴露
 * （localhost 和 https 算，其它 http 不算），所以那种地址下录音一定被挡。
 *
 * 原来那句话是「当前浏览器不支持录音」——**误诊**，会让人以为该换浏览器。
 * 这个分支只在非 localhost 地址下才走到，手动永远测不到，所以必须有测试。
 */
describe('非安全地址（局域网 http）下要说对原因', () => {
  const mount = () =>
    render(
      <MemoryRouter>
        <Recorder target="book" entry="book" referenceUrl="/api/audio/book-mw.mp3" />
      </MemoryRouter>,
    );

  it('不是安全上下文 → 说清是地址的限制，并给出 localhost 那条路', async () => {
    // 两件事一起造：mediaDevices 不存在（安全上下文才暴露），isSecureContext 为 false
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    vi.resetModules();
    const { default: Fresh } = await import('./Recorder');   // micSupported 是模块级常量，要重新加载
    // 断言这一次渲染的 container，不是 document.body —— body 里混着前面用例留下的
    // antd message（"评测失败"那几条），拿它断言会被别的用例污染。
    const { container } = render(
      <MemoryRouter>
        <Fresh target="book" entry="book" referenceUrl="/api/audio/book-mw.mp3" />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('localhost');   // 给得出能照做的下一步
    expect(text).toContain('地址');         // 说清病因是地址，不是浏览器
    // 旧那句误诊的原话不许再出现。**不能只查"浏览器不支持"**：新文案里就有
    // 「这不是浏览器不支持，是地址的限制」——那是主动堵住误解的好话，第一版断言把它撞了。
    expect(text).not.toContain('当前浏览器不支持录音');
  }, 15000);

  it('地址是安全的、但浏览器真的不支持 → 说浏览器，别怪地址', async () => {
    // **这一条第一版是空对空的**：它用顶部导入的 Recorder，那时 micSupported 已经是 true，
    // 整个 {!micSupported && …} 分支压根不渲染，断言必然通过——变异测试里
    // 「insecureOrigin 恒为真」因此活了下来。
    // 要测这个分支，必须造出"麦克风不可用 + 地址是安全的"这一种组合。
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    vi.resetModules();
    const { default: Fresh } = await import('./Recorder');
    const { container } = render(
      <MemoryRouter>
        <Fresh target="book" entry="book" referenceUrl="/api/audio/book-mw.mp3" />
      </MemoryRouter>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('当前浏览器不支持录音');   // 这时该说浏览器
    expect(text).not.toContain('localhost');        // 不该拿地址当理由
  }, 15000);

  it('麦克风可用时两条提示都不出现', () => {
    mount();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('当前浏览器不支持录音');
    expect(text).not.toContain('浏览器只在安全地址上给麦克风');
  });
});

// ────────────────────────────────────────────────────────────────────
describe('AudioPlayer 与全局的 speechSynthesis', () => {
  // speechSynthesis 是**全局单例**，页面上同时渲染着多个 AudioPlayer。
  // 所以"卸载就 cancel"是错的——那会掐掉别人正在读的那一条。
  // AudioPlayer.tsx 只在确实是自己起的朗读时才 cancel，这条规则值得有网。
  it('自己没在朗读时卸载 → 不许动全局的 cancel', async () => {
    const { unmount } = render(<AudioPlayer src="/api/audio/book-mw.mp3" label="book" />);
    await act(async () => { unmount(); });
    expect(speechCancels).toBe(0);
  });

  it('自己正在朗读时卸载 → 必须 cancel，否则换了页面它还在念', async () => {
    // src 为 null 才走 speechSynthesis 那条路（没有音频文件时的兜底）
    const { unmount } = render(<AudioPlayer src={null} label="book" />);
    const btn = screen.getByRole('button');
    await act(async () => { btn.click(); });
    const afterClick = speechCancels;       // 起朗读前它自己会先 cancel 一次，作为基线
    await act(async () => { unmount(); });
    expect(speechCancels).toBeGreaterThan(afterClick);
  });
});

/**
 * 没装 uv → **立刻**说清楚，不要让人等。
 *
 * 边车是 uv 拉起来的。一个从没装过 Python 的新用户，边车永远不会好，而原来的界面
 * 会说「正在加载模型，稍等十几秒」，熬满 90 秒才改口叫他去看启动服务那个终端窗口——
 * 而他多半是双击启动的，本来就是为了不碰终端。
 *
 * 这三条守的是：说得早、说得准、没证据不说。
 */
describe('这台机器没装 uv 时', () => {
  async function withHealth(h: { ok: boolean; uv?: boolean }) {
    healthStub.impl = () => Promise.resolve(h as { ok: boolean; uv: boolean });
    render(<AsrStatus />);
    await waitFor(() => expect(document.body.textContent).toMatch(/uv|加载模型/));
    return document.body.textContent ?? '';
  }

  it('立刻说没装，而不是让人等模型加载', async () => {
    const t = await withHealth({ ok: false, uv: false });
    expect(t).toMatch(/uv/);
    expect(t, '还在说"正在加载模型"').not.toMatch(/稍等十几秒/);
  });

  it('在浏览器里就给出装法，不打发人去翻终端', async () => {
    const t = await withHealth({ ok: false, uv: false });
    expect(t, '没给可照做的装法').toMatch(/pip install uv|winget|brew/);
    expect(t, '又把人打发去看终端了').not.toMatch(/终端窗口/);
  });

  it('并且说清楚在那之前哪些还能用——别让人以为整个工具废了', async () => {
    const t = await withHealth({ ok: false, uv: false });
    expect(t).toMatch(/照常|仍然|还能/);
  });

  it('服务端没给 uv 这个字段 → 不许下"你没装"的结论，退回原来的等待', async () => {
    // 说"你没装 uv"是一句关于他机器的断言。字段缺失（旧服务、响应被截断）时没有证据，
    // 没证据就不许说。
    const t = await withHealth({ ok: false });
    expect(t).toMatch(/加载模型/);
    expect(t, '凭空断言了没装 uv').not.toMatch(/pip install uv/);
  });
});
