// 真 UserManager + 真文件 + createApp：验证隔离和备份往返这两条 spec 断言。
// 不 mock UserManager——上面五个任务的东西在这里第一次被真正拼在一起验证。
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppDeps } from './app.js';
import { UserManager } from './users.js';
import { testDeps } from './app.test.js';

function realDeps(): { deps: AppDeps; um: UserManager } {
  const root = mkdtempSync(join(tmpdir(), 'mu-'));
  // UserManager 建新用户时从这个模板铺档案（users.ts 的 ensureFiles）——
  // 不写这个文件的话新建用户那步不会报错，只是档案不会被铺出来，这里补齐它。
  writeFileSync(join(root, '发音档案.template.md'), '# 发音档案\n', 'utf8');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const um = new UserManager({ root, dataDir });
  const base = testDeps();
  const deps: AppDeps = {
    ...base,
    // getter：跟着当前用户走，而不是构造这一刻的用户。切换之后 app 该看见新用户的库。
    get db() { return um.current().db; },
    get review() { return um.current().review; },
    get profileFile() { return um.current().profileFile; },
    users: {
      current: () => um.current().name,
      list: () => um.list(),
      switchTo: (n) => um.switchTo(n),
      create: (n) => um.create(n),
    },
  };
  return { deps, um };
}

const wav = new Uint8Array([1, 2, 3, 4]);

async function record(deps: AppDeps, word: string, heard: string) {
  deps.recognizePhonemes = vi.fn().mockResolvedValue({ reachable: true, ipa: heard, phones: null, reason: null });
  await createApp(deps).request(`/api/pronounce?target=${word}&snr=35`, { method: 'POST', body: wav });
}

async function attempts(deps: AppDeps): Promise<number> {
  const d = await (await createApp(deps).request('/api/stats')).json();
  return d.overall.attempts;
}

describe('多用户集成', () => {
  it('隔离：甲的录音乙看不见，切回来还在', async () => {
    const { deps, um } = realDeps();
    await record(deps, 'night', 'l aɪ t');          // 甲（默认）：n→l 一次
    expect(await attempts(deps)).toBe(1);

    expect(um.create('乙')).toBe('ok');
    expect(um.switchTo('乙')).toBe('ok');
    expect(await attempts(deps)).toBe(0);            // 乙一片空白

    expect(um.switchTo('默认')).toBe('ok');
    expect(await attempts(deps)).toBe(1);            // 甲的还在
    um.current().db.close();
  });

  it('备份往返：甲导出 → 切乙导入 → 乙获得甲的记录（格式零变更）', async () => {
    const { deps, um } = realDeps();
    await record(deps, 'night', 'l aɪ t');
    const app = createApp(deps);
    const backup = await (await app.request('/api/backup')).json();

    um.create('乙');
    um.switchTo('乙');
    expect(await attempts(deps)).toBe(0);
    const res = await createApp(deps).request('/api/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backup),
    });
    expect(res.status).toBe(200);
    expect(await attempts(deps)).toBe(1);
    um.current().db.close();
  });
});
