import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// .env 的最小读写。只认 `KEY=value` 这一种最朴素的形式——这个文件目前只放一个
// MW_API_KEY，不值得为它引入一个 dotenv 写入库（dotenv 自己也只负责读、不负责写）。
//
// 写入必须保留文件里其它行（包括注释和空行）：用户完全可能自己在里面加了别的东西，
// 从设置页改一个 key 不该把它们一并抹掉。

/** 从 .env 文本里取某个键的值；没有这一行、或值为空则返回 null */
export function readEnvValue(text: string, key: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m || m[1] !== key) continue;
    // 去掉可选的包裹引号
    const raw = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    return raw || null;
  }
  return null;
}

/**
 * 在 .env 文本里写入/覆盖/删除某个键，其余行原样保留。
 * value 传 null 表示删掉这一行。
 */
export function upsertEnvValue(text: string, key: string, value: string | null): string {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return m?.[1] === key;
  });

  if (value === null) {
    if (idx === -1) return text;
    lines.splice(idx, 1);
  } else if (idx === -1) {
    // 追加到末尾；确保前面不是空行堆叠
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  } else {
    lines[idx] = `${key}=${value}`;
  }
  return lines.join('\n');
}

export function readEnvFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

// 跟 review-state.json 一样走 tmp + rename：.env 里可能还有用户自己加的其它变量，
// 中途断电留下半个文件会把它们一起弄坏。
export function writeEnvFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw e;
  }
}

/** 只露出末 4 位，用于在界面上确认"配的是哪一个"而不回显完整密钥 */
export function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}
