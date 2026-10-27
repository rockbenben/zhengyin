// 下载随包的 node.exe 与 uv.exe。版本与校验和在 scripts/runtime-versions.json。
//
// 第一次（或换版本）：node scripts/fetch-runtime.mjs --record
//   —— 下载、打印并写回 SHA256；这一步是「信任首次下载」，之后必须校验。
// 之后：                 node scripts/fetch-runtime.mjs
//   —— 哈希不匹配就失败，不把可疑的二进制放进安装包。
//
// 产物在 desktop/vendor/（gitignored），由 electron-builder 的 extraResources
// 带进 resources/runtime/。许可证也一起带上：Node 的 LICENSE 在 zip 里，
// uv 的两份从它的仓库按 tag 取。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionsFile = join(root, 'scripts', 'runtime-versions.json');
const vendor = join(root, 'desktop', 'vendor');
const record = process.argv.includes('--record');

const NODE_URL = (v) => `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`;
const UV_URL = (v) => `https://github.com/astral-sh/uv/releases/download/${v}/uv-x86_64-pc-windows-msvc.zip`;
const UV_LICENSE = (v, file) => `https://raw.githubusercontent.com/astral-sh/uv/${v}/${file}`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchBytes(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`下载失败 ${r.status}: ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function findEntry(zip, name) {
  return zip.getEntries().find((e) => e.entryName === name || e.entryName.endsWith(`/${name}`));
}

async function ensure(key, url, exe) {
  const cur = versions[key];
  if (!cur.version) throw new Error(`scripts/runtime-versions.json 里 ${key}.version 还是空的`);
  process.stdout.write(`[runtime] ${key} ${cur.version} … `);
  const bytes = await fetchBytes(url(cur.version));
  const digest = sha256(bytes);
  if (!record && cur.sha256 && digest !== cur.sha256) {
    throw new Error(`${key} 的 SHA256 不匹配：期望 ${cur.sha256}，实际 ${digest}`);
  }
  const zip = new AdmZip(bytes);
  const entry = findEntry(zip, exe);
  if (!entry) throw new Error(`${key}.zip 里找不到 ${exe}`);
  writeFileSync(join(vendor, exe), entry.getData());

  if (key === 'node') {
    const license = findEntry(zip, 'LICENSE');
    if (license) writeFileSync(join(vendor, 'LICENSE-node.txt'), license.getData());
  }
  console.log(`ok (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  return digest;
}

if (process.platform !== 'win32') {
  console.error('[runtime] 计划一只发 Windows x64；这个脚本只在 Windows 上跑。');
  process.exit(1);
}

mkdirSync(vendor, { recursive: true });
const versions = JSON.parse(readFileSync(versionsFile, 'utf8'));
try {
  const nodeDigest = await ensure('node', NODE_URL, 'node.exe');
  const uvDigest = await ensure('uv', UV_URL, 'uv.exe');

  const mit = await fetchBytes(UV_LICENSE(versions.uv.version, 'LICENSE-MIT'));
  const apache = await fetchBytes(UV_LICENSE(versions.uv.version, 'LICENSE-APACHE'));
  writeFileSync(join(vendor, 'LICENSE-uv.txt'), Buffer.concat([mit, Buffer.from('\n\n'), apache]));

  if (record) {
    versions.node.sha256 = nodeDigest;
    versions.uv.sha256 = uvDigest;
    writeFileSync(versionsFile, `${JSON.stringify(versions, null, 2)}\n`);
    console.log('[runtime] 已把 SHA256 写回 scripts/runtime-versions.json');
  }
  for (const f of ['node.exe', 'uv.exe', 'LICENSE-node.txt', 'LICENSE-uv.txt']) {
    if (!existsSync(join(vendor, f))) throw new Error(`没有生成 ${f}`);
  }
  console.log(`[runtime] ok：node ${versions.node.version} / uv ${versions.uv.version}`);
} catch (e) {
  console.error(`[runtime] ${e.message}`);
  process.exit(1);
}
