/**
 * 这个工具的名字，只此一份。
 *
 * 它还要出现在两个 React 管不着的地方——静态 index.html 的标题、package.json 的
 * name。`brand.test.ts` 把这几处钉在一起：改一处忘了别处会直接红。
 */
export const APP_NAME = '正音';

/** 副题：说清目标口音。刊头上跟在名字后面 */
export const APP_TAGLINE = '美式发音';

/**
 * 服务起来时在启动窗口里打的那句话。
 *
 * **这是一份拷贝**：原件在 `server/src/index.ts`，而 server 和 web 是两个独立的包，
 * 不引共享包就传不过来。拷贝会跟原件脱节（真发生过：设置页引了一句早已删掉的英文），
 * 所以 `SettingsPage.test.tsx` 直接读 index.ts 的源码比对。
 */
export const STOP_HINT = '要停下来：关掉这个窗口，或者按 Ctrl+C';

/**
 * 源码在哪。侧栏页脚那个 GitHub 链接用它。
 *
 * 跟 `package.json` 的 `repository.url` 是同一个仓库，`brand.test.ts` 比对着——
 * 改了仓库地址忘了改这里，界面上那个链接会静默指向一个不存在的地方。
 */
export const REPO_URL = 'https://github.com/rockbenben/zhengyin';

/**
 * 在**这台机器上**打开这个应用的地址。
 *
 * 端口从当前页面取——`.env` 里 `PORT=30041` 改过之后这里跟着变；取不到才退回默认。
 * 写成一处是因为它曾经有两份：Recorder 那句 toast 写死 30031，
 * 而同一情形下面那条 Notice 用的是 location.port——**同一句话，一个对一个错**。
 * 默认值 30031 的由来见 server/src/index.ts 顶上那段。
 */
export function localAppUrl(): string {
  return `http://localhost:${typeof location !== 'undefined' && location.port ? location.port : '30031'}`;
}
