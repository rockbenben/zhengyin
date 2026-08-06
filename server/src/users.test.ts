import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_USER, invalidUserName, listUsers, migrateLegacyLayout,
  readCurrentUser, writeCurrentUser, UserManager, usersDirOf,
} from './users.js';
import { openDb } from './db.js';

function tempRoot(): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'users-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

describe('invalidUserName', () => {
  it.each(['张三', '默认', 'Tom', 'a b', '李四2'])('放行正常名字 %s', (n) => {
    expect(invalidUserName(n)).toBeNull();
  });
  it.each([
    '', '   ', 'a/b', 'a\\b', '..', 'x..y', '.开头',
    'x'.repeat(41),
  ])('拒绝 %j', (n) => {
    expect(invalidUserName(n)).not.toBeNull();
  });

  it('拒绝控制字符', () => {
    expect(invalidUserName('带控制符')).not.toBeNull();
  });

  it.each([
    '9:00', 'a*b', 'x?y', 'say"hi"', 'a<b', 'c>d', 'x|y',
  ])('拒绝 Windows 保留字符 %j', (n) => {
    expect(invalidUserName(n)).not.toBeNull();
  });

  it.each([
    'CON', 'con', 'PRN', 'prn', 'AUX', 'aux', 'NUL', 'nul',
    'COM1', 'com1', 'COM9', 'lpt1', 'LPT9', 'lpt9',
    'CON.txt', 'prn.md', 'COM5.doc', 'LPT1.exe',
  ])('拒绝 Windows 保留设备名（包括扩展名形式）%j', (n) => {
    expect(invalidUserName(n)).not.toBeNull();
  });
});

describe('当前用户指针', () => {
  it('缺文件 → null；写了再读 → 原样', () => {
    const { dataDir } = tempRoot();
    expect(readCurrentUser(dataDir)).toBeNull();
    writeCurrentUser(dataDir, '张三');
    expect(readCurrentUser(dataDir)).toBe('张三');
  });
  it('文件里只有空白 → null', () => {
    const { dataDir } = tempRoot();
    writeFileSync(join(dataDir, '当前用户.txt'), '  \n', 'utf8');
    expect(readCurrentUser(dataDir)).toBeNull();
  });
});

describe('migrateLegacyLayout', () => {
  it('把旧布局三件套原样搬进 users/默认/，写指针，返回 true', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'DBBYTES', 'utf8');
    writeFileSync(join(dataDir, 'index.db-wal'), 'WAL', 'utf8');
    writeFileSync(join(root, 'review-state.json'), '{"a":1}', 'utf8');
    writeFileSync(join(root, '发音档案.md'), '# 档案', 'utf8');

    expect(migrateLegacyLayout(root, dataDir)).toBe(true);

    const dir = join(dataDir, 'users', DEFAULT_USER);
    expect(readFileSync(join(dir, 'index.db'), 'utf8')).toBe('DBBYTES');       // 逐字节不变
    expect(readFileSync(join(dir, 'index.db-wal'), 'utf8')).toBe('WAL');       // WAL 侧车一起搬
    expect(readFileSync(join(dir, 'review-state.json'), 'utf8')).toBe('{"a":1}');
    expect(readFileSync(join(dir, '发音档案.md'), 'utf8')).toBe('# 档案');
    expect(existsSync(join(dataDir, 'index.db'))).toBe(false);                 // 旧路径不留
    expect(existsSync(join(root, 'review-state.json'))).toBe(false);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);
  });

  it('幂等：搬过一次后再跑，无副作用返回 false', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');
    migrateLegacyLayout(root, dataDir);
    expect(migrateLegacyLayout(root, dataDir)).toBe(false);
  });

  it('全新安装（无 index.db 无 users/）不触发', () => {
    const { root, dataDir } = tempRoot();
    expect(migrateLegacyLayout(root, dataDir)).toBe(false);
    expect(existsSync(join(dataDir, 'users'))).toBe(false);   // 建默认用户是 UserManager 的事
  });

  it('users/ 已存在但不是我们创建的（无 index.db 无 users/默认/）就不动', () => {
    const { root, dataDir } = tempRoot();
    mkdirSync(join(dataDir, 'users'), { recursive: true });
    expect(migrateLegacyLayout(root, dataDir)).toBe(false);
  });

  it('users/ 已存在且旧 db 也在，继续搬（续跑场景）', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');
    writeFileSync(join(root, 'review-state.json'), '{}', 'utf8');
    // 模拟中途中断：users/ 已经建了但指针还没写
    mkdirSync(join(dataDir, 'users'), { recursive: true });
    // db 还在旧位置（还没搬）
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'users', DEFAULT_USER, 'index.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'index.db'))).toBe(false);
  });

  it('三件套只有部分存在也能搬（比如从没跑过评测、没有档案）', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');   // 只有 db
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);
    expect(existsSync(join(dataDir, 'users', DEFAULT_USER, 'index.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'users', DEFAULT_USER, '发音档案.md'))).toBe(false);
  });

  it('可续跑：中途被杀后，下次启动补搬剩余文件', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'DB', 'utf8');
    writeFileSync(join(root, 'review-state.json'), '{}', 'utf8');
    writeFileSync(join(root, '发音档案.md'), 'PROFILE', 'utf8');

    // 第一次启动，搬文件
    const dir = join(dataDir, 'users', DEFAULT_USER);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dataDir, 'index.db');
    if (existsSync(dbPath)) {
      const content = readFileSync(dbPath, 'utf8');
      writeFileSync(join(dir, 'index.db'), content, 'utf8');
    }
    // 删除旧 db（模拟搬了）
    // 但不写指针，模拟中途被杀的状态

    // 第二次启动：指针还是 null，所以应该继续搬
    expect(readCurrentUser(dataDir)).toBeNull();
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);

    // 检查所有文件都被搬到了新位置
    expect(readFileSync(join(dir, 'review-state.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(dir, '发音档案.md'), 'utf8')).toBe('PROFILE');
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);
    expect(existsSync(join(root, 'review-state.json'))).toBe(false);
  });

  it('Critical 修复：迁移完成后切到其他用户，再调 migrateLegacyLayout 指针不被改回', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');

    // 第一次迁移：完成
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);

    // 用户切到张三
    mkdirSync(join(dataDir, 'users', '张三'), { recursive: true });
    writeCurrentUser(dataDir, '张三');
    expect(readCurrentUser(dataDir)).toBe('张三');

    // 重新调用 migrateLegacyLayout（比如重启服务）：指针不应该被改回
    expect(migrateLegacyLayout(root, dataDir)).toBe(false);
    expect(readCurrentUser(dataDir)).toBe('张三'); // 关键：仍然是张三
  });

  it('Critical 修复：指针丢失且有多个用户时，不强制写成默认', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');

    // 第一次迁移：完成
    migrateLegacyLayout(root, dataDir);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);

    // 创建第二个用户
    mkdirSync(join(dataDir, 'users', '张三'), { recursive: true });

    // 删掉指针文件（模拟意外情况）
    const currentFile = join(dataDir, '当前用户.txt');
    if (existsSync(currentFile)) {
      writeFileSync(currentFile, '', 'utf8');
    }
    expect(readCurrentUser(dataDir)).toBeNull();

    // 再调 migrateLegacyLayout：不应该强制写成默认
    expect(migrateLegacyLayout(root, dataDir)).toBe(false);
    expect(readCurrentUser(dataDir)).toBeNull(); // 关键：不被改写
  });

  it('Critical 修复：没搬任何东西时不写指针，仅设置指针的重复调用返回 false', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');

    // 第一次：搬完
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);
    const dir = join(dataDir, 'users', DEFAULT_USER);
    expect(existsSync(join(dir, 'index.db'))).toBe(true);

    // 第二次：什么都没搬，应该返回 false 且不改指针
    expect(migrateLegacyLayout(root, dataDir)).toBe(false);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER); // 仍是默认
  });

  it('Important 修复：文件全搬完但指针未写的卡死状态能补救', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'DB', 'utf8');
    writeFileSync(join(root, 'review-state.json'), 'STATE', 'utf8');

    // 第一次迁移：手动搬所有文件但不写指针（模拟最后一步被杀）
    const dir = join(dataDir, 'users', DEFAULT_USER);
    mkdirSync(dir, { recursive: true });
    // 搬所有文件
    const dbPath = join(dataDir, 'index.db');
    if (existsSync(dbPath)) {
      writeFileSync(join(dir, 'index.db'), readFileSync(dbPath, 'utf8'), 'utf8');
    }
    const statePath = join(root, 'review-state.json');
    if (existsSync(statePath)) {
      writeFileSync(join(dir, 'review-state.json'), readFileSync(statePath, 'utf8'), 'utf8');
    }
    // 指针还是 null（模拟写指针被杀）
    expect(readCurrentUser(dataDir)).toBeNull();

    // 第二次启动：应该补写指针并返回 true
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER); // 指针被补成默认
  });

  it('Important 修复：users/ 下有文件但指针指向不存在的用户时能补写', () => {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(dataDir, 'index.db'), 'X', 'utf8');

    // 第一次迁移完成
    migrateLegacyLayout(root, dataDir);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);

    // 指针被手动改成一个不存在的用户
    writeCurrentUser(dataDir, '幽灵用户');
    expect(readCurrentUser(dataDir)).toBe('幽灵用户');

    // 再调 migrateLegacyLayout：应该补写指针成默认
    expect(migrateLegacyLayout(root, dataDir)).toBe(true);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);
  });
});

describe('UserManager', () => {
  function makeRoot(): { root: string; dataDir: string } {
    const { root, dataDir } = tempRoot();
    writeFileSync(join(root, '发音档案.template.md'), '# 发音档案\n（模板）\n', 'utf8');
    return { root, dataDir };
  }

  it('全新安装：建「默认」，档案从模板铺，指针写好', () => {
    const { root, dataDir } = makeRoot();
    const um = new UserManager({ root, dataDir });
    expect(um.current().name).toBe(DEFAULT_USER);
    expect(um.list()).toEqual([DEFAULT_USER]);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);
    expect(readFileSync(um.current().profileFile, 'utf8')).toContain('（模板）');
    um.current().db.close();
  });

  it('构造时自动跑旧布局迁移', () => {
    const { root, dataDir } = makeRoot();
    writeFileSync(join(root, '发音档案.md'), '# 老档案', 'utf8');
    // 旧 db 得是真 sqlite 文件（构造后要被 openDb 打开）
    openDb(join(dataDir, 'index.db')).close();
    const um = new UserManager({ root, dataDir });
    expect(um.current().name).toBe(DEFAULT_USER);
    expect(readFileSync(um.current().profileFile, 'utf8')).toBe('# 老档案');  // 老档案原样，不被模板盖掉
    um.current().db.close();
  });

  it('指针指向不存在的用户 → 回落到按名字排序的第一个', () => {
    const { root, dataDir } = makeRoot();
    const um1 = new UserManager({ root, dataDir });
    um1.create('张三');
    um1.current().db.close();
    writeCurrentUser(dataDir, '不存在的人');
    const um2 = new UserManager({ root, dataDir });
    expect(['张三', DEFAULT_USER]).toContain(um2.current().name);  // 排序第一个（zh locale）
    expect(um2.current().name).toBe(um2.list()[0]);
    um2.current().db.close();
  });

  it('switchTo：不存在 → not-found 且不切；非法名 → invalid', () => {
    const { root, dataDir } = makeRoot();
    const um = new UserManager({ root, dataDir });
    expect(um.switchTo('没这人')).toBe('not-found');
    expect(um.current().name).toBe(DEFAULT_USER);
    expect(um.switchTo('../逃逸')).toBe('invalid');
    um.current().db.close();
  });

  it('create + switchTo：新用户空库、独立档案；切换后指针跟着走', () => {
    const { root, dataDir } = makeRoot();
    const um = new UserManager({ root, dataDir });
    expect(um.create('张三')).toBe('ok');
    expect(um.create('张三')).toBe('exists');
    expect(um.list()).toContain('张三');
    expect(um.switchTo('张三')).toBe('ok');
    expect(um.current().name).toBe('张三');
    expect(readCurrentUser(dataDir)).toBe('张三');
    um.current().db.close();
  });

  it('onOpen 在启动和每次切换后各跑一次，拿到的是那个用户的会话', () => {
    const { root, dataDir } = makeRoot();
    const seen: string[] = [];
    const um = new UserManager({ root, dataDir, onOpen: (s) => seen.push(s.name) });
    um.create('张三');
    um.switchTo('张三');
    expect(seen).toEqual([DEFAULT_USER, '张三']);
    um.current().db.close();
  });

  it('onOpen 抛异常时 new UserManager 不抛，会话仍然可用', () => {
    const { root, dataDir } = makeRoot();
    let um!: UserManager;
    expect(() => {
      um = new UserManager({ root, dataDir, onOpen: () => { throw new Error('仪式挂了'); } });
    }).not.toThrow();
    expect(um.current().name).toBe(DEFAULT_USER);
    // 会话本身可用：db 句柄真的能查
    expect(um.current().db.prepare('SELECT 1 AS x').get()).toEqual({ x: 1 });
    um.current().db.close();
  });

  it('switchTo 时 onOpen 抛异常 → 不抛出去，新会话有效，磁盘指针也真的切过去了', () => {
    const { root, dataDir } = makeRoot();
    // 只在切到非默认用户时抛，隔离出"切换"这一条路径，跟上一条构造期的用例分开验证
    const um = new UserManager({
      root, dataDir,
      onOpen: (s) => { if (s.name !== DEFAULT_USER) throw new Error('仪式挂了'); },
    });
    expect(um.create('张三')).toBe('ok');
    expect(() => {
      expect(um.switchTo('张三')).toBe('ok');
    }).not.toThrow();
    // 三者必须一致：内存里的活跃会话、它的 db 句柄、磁盘上的指针
    expect(um.current().name).toBe('张三');
    expect(um.current().db.prepare('SELECT 1 AS x').get()).toEqual({ x: 1 });
    expect(readCurrentUser(dataDir)).toBe('张三');
    um.current().db.close();
  });

  it('switchTo 遇到同名的普通文件（非目录）→ not-found，不当成有效用户', () => {
    const { root, dataDir } = makeRoot();
    const um = new UserManager({ root, dataDir });
    writeFileSync(join(usersDirOf(dataDir), '文件用户'), '不是目录', 'utf8');
    expect(um.switchTo('文件用户')).toBe('not-found');
    expect(um.current().name).toBe(DEFAULT_USER);
    um.current().db.close();
  });

  it('switchTo 目标库打不开（非法 sqlite 文件）时抛出，但不留下一块砖：旧会话、指针、db 句柄都还能用', () => {
    const { root, dataDir } = makeRoot();
    const um = new UserManager({ root, dataDir });
    expect(um.create('乙')).toBe('ok');
    // 覆盖成一段非 sqlite 的垃圾字节——手工放的、拷贝重命名的、或者被杀软/同步盘
    // 锁住写坏的文件都会长这样
    writeFileSync(join(usersDirOf(dataDir), '乙', 'index.db'), '不是sqlite文件的字节', 'utf8');

    expect(() => um.switchTo('乙')).toThrow();

    // 三件事都不能变：内存里的活跃用户、磁盘上的指针、旧会话的 db 句柄
    expect(um.current().name).toBe(DEFAULT_USER);
    expect(readCurrentUser(dataDir)).toBe(DEFAULT_USER);
    expect(um.current().db.prepare('select 1 as x').get()).toEqual({ x: 1 });
    um.current().db.close();
  });
});
