// electron-builder 配置：NSIS 安装版。
// 服务端运行时依赖由 scripts/server-runtime-deps.mjs 从 server/package.json 的闭包算出，
// 不手抄；少带一个的症状是包打得出来、装出来点开才炸。
import { serverRuntimeResources } from '../scripts/server-runtime-deps.mjs';

const root = process.cwd();

const base = {
  appId: 'com.rockbenben.zhengyin',
  productName: '正音',
  copyright: '个人使用',
  directories: {
    app: 'desktop',
    output: 'desktop/release',
    buildResources: 'desktop/build',
  },
  files: ['dist/**/*', 'build/icon.png', 'package.json'],
  asar: true,
  npmRebuild: false,
  // ── 打包后不需要的运行时能力全关掉（只影响打包产物，开发模式用的二进制不变）──
  // runAsNode：本应用从不靠 ELECTRON_RUN_AS_NODE 起进程（服务端用随包 node.exe）；
  // NODE_OPTIONS / --inspect：成品不需要，关掉免得环境变量或调试参数改运行时行为；
  // cookie 加密：这应用没有登录态，开着不亏；
  // asar 完整性 + 只从 app.asar 加载：改过的 app.asar 会被 Electron 直接拒绝启动。
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  extraMetadata: { zhengyinChannel: 'nsis' },
  publish: { provider: 'github', owner: 'rockbenben', repo: 'zhengyin' },
  extraResources: [
    { from: 'server/dist', to: 'server/dist' },
    { from: 'web/dist', to: 'web/dist' },
    { from: 'notes', to: 'notes' },
    { from: 'workflows', to: 'workflows' },
    {
      from: 'asr-service',
      to: 'asr-service',
      filter: ['main.py', 'pyproject.toml', 'uv.lock', '.python-version'],
    },
    { from: '发音档案.template.md', to: '发音档案.template.md' },
    { from: 'scripts/vosk-models.json', to: 'scripts/vosk-models.json' },
    { from: 'desktop/vendor/node.exe', to: 'runtime/node.exe' },
    { from: 'desktop/vendor/uv.exe', to: 'runtime/uv.exe' },
    { from: 'desktop/vendor/LICENSE-node.txt', to: 'runtime/LICENSE-node.txt' },
    { from: 'desktop/vendor/LICENSE-uv.txt', to: 'runtime/LICENSE-uv.txt' },
    ...serverRuntimeResources(root),
  ],
  win: {
    artifactName: 'zhengyin-${version}-win.${ext}',
    target: [{ target: 'nsis' }],
  },
  nsis: {
    artifactName: 'zhengyin-${version}-win-setup.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerLanguages: ['zh_CN'],
    displayLanguageSelector: false,
  },
};

export default base;
