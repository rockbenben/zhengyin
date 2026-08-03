// `npm run asr` 的前置检查（npm 会自动先跑 preasr）。
//
// 只做一件事：uv 不在 PATH 上时，把 shell 那句没有信息量的报错
// （Windows：`'uv' 不是内部或外部命令`）换成一段能照着做的说明。
//
// **跟之前删掉的那个守卫脚本的区别，是这个文件存在的全部理由：**
// 那个检查 `.venv` 在不在、不在就拒绝启动——而 `uv run` 本来就会自己建 venv 装依赖
// （实测 45 个包 71 秒），于是它拦下了一个能自愈的情况，纯属有害。
// uv 本身缺失不会自愈：不装就是跑不了，这条命令原本也只会失败。所以这里没有挡掉任何
// 一个能跑的场合，只是把失败时那句话换成有用的。加东西之前先问"它挡掉了什么"，
// 答案必须是"什么都没挡掉"。
//
// 界面上「音素识别服务没启动」那条提示会让人**回来看这个终端**
// （web/src/components/Recorder.tsx）。所以这里必须给得出答案，否则那条指引是空的。

import { spawnSync } from 'node:child_process';

// shell:true 让 Windows 上走 cmd 的 PATH 查找（uv 可能是个 .cmd shim）；
// stdio:'ignore' 吞掉它自己那句报错。
// **命令整串传**：shell:true 配参数数组会触发 Node 的 DEP0190，
// 往用户窗口里打一句带 "security vulnerabilities" 的英文告警。
if (spawnSync('uv --version', { stdio: 'ignore', shell: true }).status === 0) {
  process.exit(0);
}

// 写 stderr 而不是 stdout：这是失败说明，不是正常输出
console.error(
  [
    '',
    '音素评测起不来：PATH 上没有 uv（Python 依赖管理工具）。',
    '',
    '不影响其他功能——查词、音标、音素条、笔记匹配、真人发音、录音、A/B 对比都照常用。',
    '只有"你第几个音发成了什么"这一项要靠它。想先随便试试的话，现在就能直接用。',
    '',
    '要装的话任选一条，装完重新 npm start：',
    '  pip install uv',
    '  winget install astral-sh.uv                      # Windows',
    '  brew install uv                                  # macOS',
    '  curl -LsSf https://astral.sh/uv/install.sh | sh  # Linux / macOS',
    '',
    'Python 不用你自己装，uv 会把它需要的那个版本一起准备好。',
    '首次启动会下约 1.2GB 模型，之后每次十几秒。',
    '',
  ].join('\n'),
);
process.exit(1);
