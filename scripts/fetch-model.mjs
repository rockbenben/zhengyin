// 下载并重新打包 Vosk 语音识别模型，供浏览器端的 vosk-browser 使用。
//
// 背景：vosk-browser（WASM）要求模型是 .tar.gz，但官方 alphacephei.com 只发布 .zip
// （跟这个项目更早版本里原生 Vosk（Node 绑定，代码曾经在 server/src/asr.ts，现已
// 删除、换成本文件描述的浏览器端方案）用的是同一个模型，格式不同）。这个脚本
// 下载官方 .zip、解压、重新打包成 .tar.gz，落到 data/models/ 下——data/ 已整体
// gitignore（见仓库根 .gitignore），这个脚本就是它的"重建方式"，模型本身永不进
// 版本库。
//
// 用法：npm run fetch-model            → 下载 .env 里 VOSK_MODEL 选中的那个（默认大模型）
//       npm run fetch-model -- small   → 下载指定的那个，不改 .env 的选择
// 可选的 id 见 scripts/vosk-models.json。产出文件名必须跟 server/src/app.ts 的
// GET /api/model/:file 白名单正则一致；前端不再写死文件名，改成问 /api/settings/model。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import AdmZip from 'adm-zip';
import * as tar from 'tar';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);

// 选哪个模型：命令行参数 > 环境变量/.env 的 VOSK_MODEL > 清单里的 default。
// 清单是 server/src/models.ts 也在读的那一份——两边绝不各写一份文件名。
// dotenv 显式指定路径：本脚本可能从仓库根也可能从 scripts/ 内部启动，不能靠 cwd。
loadEnv({ path: join(root, '.env'), quiet: true });
const registry = JSON.parse(readFileSync(join(scriptDir, 'vosk-models.json'), 'utf8'));
const wanted = process.argv[2] || process.env.VOSK_MODEL || registry.default;
const entry = registry.models.find((m) => m.id === wanted);
if (!entry) {
  const ids = registry.models.map((m) => m.id).join(' / ');
  console.error(`[fetch-model] 不认识的模型 id：${wanted}。可选：${ids}`);
  process.exit(1);
}
const MODEL = entry.name;
const ZIP_URL = `https://alphacephei.com/vosk/models/${MODEL}.zip`;
console.log(`[fetch-model] 目标：${entry.label}（${entry.id}）`);
const modelsDir = join(root, 'data', 'models');
const modelDir = join(modelsDir, MODEL);
const zipPath = join(modelsDir, `${MODEL}.zip`);
const tarGzPath = join(modelsDir, `${MODEL}.tar.gz`);
// 临时名带 pid，避免两个 fetch-model 同时在跑（用户以为卡住了、又开一个终端重来）时
// 打进同一个文件互相截断。注意这只隔离了打包产物：zip 和解压目录仍然是共享的，真并发
// 跑两份依然会互相踩（一方 rmSync(zipPath) 另一方正要读它）。这个脚本就不是设计给并发
// 跑的——同时只跑一个。
const tmpTarGzPath = `${tarGzPath}.${process.pid}.tmp`;
// 打好了但 rename 没成功时挪到这个**固定**名字。用固定名而不是带 pid 的临时名，下次运行
// 才认得出它、直接接手改名，省掉整包重下。带 pid 的 .tmp 一律视为半成品，可以随便清。
const pendingTarGzPath = `${tarGzPath}.pending`;

// tar 是否已经打完（决定失败时 .tmp 是半成品该删、还是完整成果该转成 .pending 留着）。
let packed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (existsSync(tarGzPath)) {
    console.log(`[fetch-model] 已存在 ${tarGzPath}，跳过下载。想强制刷新就先删掉这个文件再重跑。`);
    return;
  }

  mkdirSync(modelsDir, { recursive: true });

  // 上次打好了但没改成名的完整压缩包：先试着接手，成功就直接完事，不用重下一整包。
  if (existsSync(pendingTarGzPath)) {
    console.log('[fetch-model] 发现上次已打包好但未改名的压缩包，尝试直接接手...');
    try {
      renameSync(pendingTarGzPath, tarGzPath);
      console.log(`[fetch-model] 完成：${tarGzPath}`);
      return;
    } catch (e) {
      console.warn(`[fetch-model] 接手失败（${e.code ?? e.message}），改为重新下载`);
    }
  }

  // 清掉历次运行留下的**半成品** .tmp（rename 没成的完整包不在此列——它已经被转成
  // .pending，上面那段会去接手，绝不能在这里被当垃圾删掉）。这个脚本不支持并发跑
  // （见上面 tmpTarGzPath 的说明），所以同名模式的 .tmp 残留可以放心全清。
  for (const name of readdirSync(modelsDir)) {
    if (!name.startsWith(`${MODEL}.tar.gz.`) || !name.endsWith('.tmp')) continue;
    try { rmSync(join(modelsDir, name), { force: true }); } catch { /* 清不掉就算了 */ }
  }

  console.log(`[fetch-model] 下载 ${ZIP_URL}（约 ${entry.sizeMb}MB，仅首次）...`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`模型下载失败：HTTP ${res.status} ${res.statusText}`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  console.log('[fetch-model] 解压...');
  new AdmZip(zipPath).extractAllTo(modelsDir, true);
  // 删这个临时 zip 只是省点空间。Windows 上 Defender 刚扫完这个大文件、还攥着句柄的情况
  // 很常见，这里抛 EBUSY 会让整次运行被判失败、连带把刚解压好的目录也清掉，下次从头重来
  // ——只因为一个临时文件没删掉，代价完全不成比例。
  try { rmSync(zipPath); } catch (e) {
    console.warn(`[fetch-model] 临时 zip ${zipPath} 没删掉（${e.message}），可手动删除，不影响后续步骤`);
  }
  if (!existsSync(modelDir)) {
    throw new Error(`解压后没找到预期目录 ${modelDir}，官方 zip 内部结构可能变了`);
  }

  console.log('[fetch-model] 重新打包为 vosk-browser 需要的 .tar.gz...');
  // 先打到临时文件、成功后再 rename 到最终名字。tarGzPath 同时是本脚本开头"已存在就
  // 跳过下载"的判据，也是服务端 GET /api/model/:file 判断模型在不在的唯一依据——所以
  // 它必须要么不存在、要么是完整的，绝不能出现"存在但是半个"的中间态：那会让重跑永远
  // 跳过重建，而 HEAD 探测照样返回 200，前端判定"模型可用"，用户点评测只拿得到
  // "识别出错"，而不是那条能指导他重下模型的"模型未安装"提示。
  // rename 是原子的，因此打包中途失败或被 Ctrl+C 打断（catch 根本来不及跑）都只会留下
  // 一个 .tmp，不会污染最终文件。
  await tar.create({ gzip: true, file: tmpTarGzPath, cwd: modelsDir, portable: true }, [MODEL]);
  packed = true;

  // rename 在 Windows 上会被 Defender 之类的实时扫描短暂占用而抛 EPERM/EBUSY，这种锁是
  // 瞬时的，重试几次基本都能过。之前的做法是失败就把打好的 .tmp 留着不删——但那个文件谁
  // 也用不上（main() 只认 tarGzPath，服务端白名单也不收 .tmp 后缀），等于白白泄漏上百 MB
  // 而下次照样重下。重试才是真的省掉那次重下。
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmpTarGzPath, tarGzPath);
      break;
    } catch (e) {
      if (attempt >= 5) {
        // 重试用尽。压缩包本身是完整的，转存成固定的 .pending 名字——下次运行会自动接手
        // （见 main() 开头），用户什么都不用做；实在想手动来也给出命令。
        let kept = tmpTarGzPath;
        try { renameSync(tmpTarGzPath, pendingTarGzPath); kept = pendingTarGzPath; } catch { /* 连转存都失败就保持原名 */ }
        console.error(`[fetch-model] rename 反复失败。压缩包本身已经打好且完整，保留在：
  ${kept}
关掉可能占用它的程序（杀毒软件实时扫描、资源管理器预览）后重跑本脚本即可自动接手，无需重下；也可以手动改名：
  move "${kept}" "${tarGzPath}"`);
        throw e;
      }
      console.warn(`[fetch-model] rename 被占用（${e.code ?? e.message}），${attempt}/4 重试中...`);
      await sleep(attempt * 500);
    }
  }
  // 到这里模型已经可用了。删中间目录只是收尾，失败最多留下几十 MB 垃圾，绝不能因此把
  // 一次成功的安装报成失败——用户会照着失败提示把刚装好的模型删掉重下。
  try {
    rmSync(modelDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[fetch-model] 中间目录 ${modelDir} 没删掉（${e.message}），可手动删除，不影响使用`);
  }

  console.log(`[fetch-model] 完成：${tarGzPath}`);
  // 「听辨」是评测的旧叫法，界面上早就统一成「评测」了；接口路径对照做的人也没用。
  // 这一行要回答的只有一件事：装完之后干嘛。
  console.log('[fetch-model] 起服务之后就能用了。它是退路——只在逐音素评测那个服务没起来时才轮到它。');
}

main().catch((e) => {
  console.error('[fetch-model] 失败：', e.message);
  // 失败时清理掉可能半下载/半解压/半打包的产物，避免下次重跑被"看起来存在但是坏的"
  // 文件卡住（比如网络中断留下的不完整 zip）。
  //
  // 只清中间产物，不碰 tarGzPath：打包走的是 tmp + rename，最终文件要么不存在、要么完整。
  //
  // 每一项单独 try/catch：清理本身也会失败（Windows 文件占用），而这里是 .catch() 回调，
  // 抛出去就变成 unhandled rejection——友好报错后面跟一坨裸栈，最后一行的 process.exitCode
  // 也执行不到。清理是尽力而为的收尾，不该反过来把进程搞崩。
  //
  // packed 为真时不删 tmp：那是已经打好的完整压缩包，上面已经打印了手动改名的命令。
  for (const p of [zipPath, modelDir, ...(packed ? [] : [tmpTarGzPath])]) {
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[fetch-model] 清理 ${p} 失败（可忽略，手动删掉即可）：`, cleanupErr.message);
    }
  }
  process.exitCode = 1;
});
