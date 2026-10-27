// 开发模式的 server 包装：只做一件事——设 ASR_AUTOSTART=0 再起 tsx watch。
//
// 不直接写 `ASR_AUTOSTART=0 npm run dev -w server`：那是 POSIX shell 语法，
// Windows 的 cmd / PowerShell 都跑不通（这个仓库的启动提示里已经栽过同一条）。
// 关掉自启是为了让 concurrently 那路独立的 `npm run asr` 持有边车：
// 否则 tsx watch 每重启一次，服务就重新加载一遍 1.2GB 模型。
import { spawn } from 'node:child_process';

// 命令是写死的字面量，整串交给 shell；不含用户输入，也不存在参数数组 + shell:true
// 的那个 DEP0190 告警。
const child = spawn('npm run dev -w server', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ASR_AUTOSTART: '0' },
});

child.on('exit', (code) => process.exit(code ?? 0));
