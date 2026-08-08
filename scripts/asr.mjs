// 起音素识别边车。**`npm run asr` 走这里，而不是直接调 uv。**
//
// 多这一层只为一件事：把 `.env` 合并进环境再 spawn uv。
// 边车是 concurrently 拉起的**兄弟进程**，而 `dotenv/config` 只在 server 那个进程里
// import——不经过这一层，`.env` 里的 MODEL_SOURCE / HF_ENDPOINT 根本传不进去，
// 而双击启动的人没有别的地方能设它们。
//

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 解析 .env 的内容。**不用 dotenv 包**：这个脚本挂在 preasr 链上，不该假设
 * node_modules 已经装好了，而这点解析用不着一个依赖。
 *
 * 只认最朴素的 KEY=VALUE：`#` 开头是注释，值两边的引号剥掉。
 * `already` 里已经有的键**不覆盖**——命令行/shell 里显式设的应该赢过文件。
 */
export function parseEnv(text, already = {}) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in already)) out[k] = v;
  }
  return out;
}

/**
 * 这段输出像不像「模型下不下来」。
 *
 * 界面上那条「等了一分半还没起来」明确让人**回来看这个终端**，而这里原本只有
 * 一段英文 Python traceback——对一个中文母语、不写代码的使用者，那是死路。
 *
 * **宁可漏报也不要误报**：正常启动时 HF 会打一句
 * 「Warning: You are sending unauthenticated requests to the HF Hub…」，
 * 还有一路 `Loading weights: 100%|…` 的进度条。误报的话每次启动都弹一屏
 * "模型没下下来"，那比不提示更糟。所以只认真正的连接类异常。
 */
export const LOOKS_LIKE_NETWORK_FAILURE =
  /ConnectionError|MaxRetryError|Read timed out|Failed to (?:resolve|establish)|SSLError|ProxyError|Temporary failure in name resolution|OSError: \[Errno -3\]/i;

/** 连不上时补的那段中文说明。抽成函数是为了能直接测它说了什么。 */
export function downloadHelp(endpoint) {
  return [
    '',
    '── 模型没下下来 ─────────────────────────────',
    '',
    `逐音素评测要先下一个约 1.2GB 的模型，这次没连上：${endpoint || 'https://huggingface.co（默认）'}`,
    '',
    '别的功能都不受影响——查词、真人发音、录音、A/B 对比、复习照常用，',
    '只有"你第几个音发成了什么"这一项要等它。',
    '',
    '可以试的两条：',
    '  1. 换个源。在正音这个文件夹里的 .env 里加一行，然后重新启动：',
    '       HF_ENDPOINT=https://hf-mirror.com',
    '     （想换回官方就把这行删掉。实测两边速度都不稳、哪个快每次都不一样，',
    '       所以这是个开关，不是"镜像一定更快"）',
    '  2. 网络本身不通的话，先把网络解决了再启动——下过一次就有缓存，不用再下。',
    '',
  ].join('\n') + '\n';
}

function main() {
  const fromFile = existsSync(join(root, '.env'))
    ? parseEnv(readFileSync(join(root, '.env'), 'utf8'), process.env)
    : {};
  // PYTHONIOENCODING 不给 .env 覆盖的机会，因为它不是配置、是这条管道的事实：
  // stdout 是管道时 Python 按**系统区域编码**写（中文 Windows 上是 GBK），
  // 而 Node 这头一律按 UTF-8 读——边车那几句中文提示（「模型不在本地缓存里，
  // 开始获取」正是首次启动最该看清的一句）在窗口里全成了「锟斤拷」。
  //
  // DISABLE_SAFETENSORS_CONVERSION 同理，它关掉的是 transformers 的一个后台线程
  // （`modeling_utils.py` 的 `Thread-auto_conversion`）：权重是 .bin 而仓库里没有
  // safetensors 时，它会去 hub 上翻有没有转换 PR，翻不着就请转换 bot 开一个。
  // 抓栈确认过那几个请求就是它发的——而它是**加载完之后**才跑完的，于是那两行
  // 「You are sending unauthenticated requests to the HF Hub」正好落在窗口最后一行，
  // 成了整个启动过程的收尾语，看着像出了什么事。
  // 对本机零收益：模型已经从 .bin 加载好了，那个 PR 是开给公共仓库的。
  const env = {
    ...process.env, ...fromFile,
    PYTHONIOENCODING: 'utf-8',
    DISABLE_SAFETENSORS_CONVERSION: '1',
  };

  // 命令整串传，别写成 ('uv', [...])——理由见 web/src/lib/spawnShell.test.ts。
  // 这里每个词都是写死的字面量、没空格，拼一串不用管引号；带空格的 cwd 是单独传的。
  const child = spawn(
    'uv run --project asr-service uvicorn main:app'
    + ' --app-dir asr-service --host 127.0.0.1 --port 30032',
    { cwd: root, env, stdio: ['ignore', 'inherit', 'pipe'], shell: true },
  );

  // 原始报错照样往下透，不吞——补的那段只是加在后面
  let said = false;
  child.stderr.on('data', (buf) => {
    const s = buf.toString();
    process.stderr.write(s);
    if (said || !LOOKS_LIKE_NETWORK_FAILURE.test(s)) return;
    said = true;
    process.stderr.write(downloadHelp(env.HF_ENDPOINT));
  });

  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => {
    process.stderr.write(`起不了 uv：${e.message}\n`);
    process.exit(1);
  });
}

// 只有被直接执行时才真去起进程——被 import 做测试时不该有任何副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
