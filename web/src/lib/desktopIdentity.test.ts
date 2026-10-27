import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { APP_NAME } from './brand';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('desktop/package.json'));

describe('桌面应用的身份字面量只有一处', () => {
  it('产品名与界面同名', () => {
    expect(pkg.productName).toBe(APP_NAME);
  });

  it('appId 是固定的 ASCII 反域名', () => {
    const cfg = read('desktop/electron-builder.config.mjs');
    expect(cfg).toContain("appId: 'com.rockbenben.zhengyin'");
  });

  it('author 必须是对象——字符串会让 exe 的 CompanyName 变成 GitHub, Inc.', () => {
    expect(typeof pkg.author).toBe('object');
    expect(pkg.author.name).toBe('rockbenben');
  });

  it('入口是 ESM，main 指向编译产物', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('dist/main.js');
  });

  it('图标就是仓库里那份 512×512，不另做资产', () => {
    const a = createHash('sha256').update(readFileSync(join(root, 'desktop/build/icon.png'))).digest('hex');
    const b = createHash('sha256').update(readFileSync(join(root, 'web/public/icon-512.png'))).digest('hex');
    expect(a).toBe(b);
    expect(existsSync(join(root, 'web/public/icon-512.png'))).toBe(true);
  });

  it('主进程的 AUMID 与 builder 的 appId 一致', () => {
    const product = read('desktop/src/product.ts');
    expect(product).toContain('com.rockbenben.zhengyin');
    expect(read('desktop/src/main.ts')).toContain('APP_ID');
    const cfg = read('desktop/electron-builder.config.mjs');
    expect(cfg).toContain("appId: 'com.rockbenben.zhengyin'");
  });

  it('产物名全 ASCII 且自带扩展名占位', () => {
    const cfg = read('desktop/electron-builder.config.mjs');
    expect(cfg).toContain('zhengyin-${version}-win.${ext}');
    expect(cfg).toContain('zhengyin-${version}-win-setup.${ext}');
  });
});
