import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "./db.js";
import { ReviewStore } from "./review.js";

/** 迁移时旧数据归的名字。改这个字符串 = 改所有已迁移用户的目录名，别动 */
export const DEFAULT_USER = "默认";

const CURRENT_FILE = "当前用户.txt";

// Windows 保留字符
const WINDOWS_RESERVED_CHARS = /[:*?"<>|]/;

// Windows 保留设备名（不分大小写）
const WINDOWS_RESERVED_DEVICES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function isWindowsReservedDeviceName(name: string): boolean {
  // 提取文件名（去扩展名）
  const fileName = basename(name, extname(name)).toUpperCase();
  return WINDOWS_RESERVED_DEVICES.has(fileName);
}

/**
 * 名字就是目录名，所以校验的实质是路径安全：斜杠、点点、点开头都能逃出
 * data/users/，控制字符会让终端和文件系统各出各的怪。Windows 保留字符和设备名
 * 会让 mkdirSync/renameSync 抛 EINVAL。合法返回 null，
 * 非法返回一句能直接给用户看的中文。
 */
export function invalidUserName(name: string): string | null {
  if (name.trim() === "") return "名字不能是空的";
  if (name !== name.trim()) return "名字前后不能带空白";
  if (/[/\\]/.test(name)) return "名字里不能带斜杠";
  if (name.includes("..")) return "名字里不能有连续的点";
  if (name.startsWith(".")) return "名字不能以点开头";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "名字里有控制字符";
  if (WINDOWS_RESERVED_CHARS.test(name)) return "名字里不能含 : * ? \" < > |";
  if (isWindowsReservedDeviceName(name)) return "不能用 Windows 保留设备名";
  if ([...name].length > 40) return "名字太长了（40 字以内）";
  return null;
}

export function usersDirOf(dataDir: string): string {
  return join(dataDir, "users");
}

export function listUsers(dataDir: string): string[] {
  const dir = usersDirOf(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, "zh"));
}

export function readCurrentUser(dataDir: string): string | null {
  const f = join(dataDir, CURRENT_FILE);
  if (!existsSync(f)) return null;
  const name = readFileSync(f, "utf8").trim();
  return name === "" ? null : name;
}

export function writeCurrentUser(dataDir: string, name: string): void {
  writeFileSync(join(dataDir, CURRENT_FILE), `${name}\n`, "utf8");
}

/**
 * 旧布局（单用户）→ 新布局（data/users/<名>/）。**原样 rename，一个字节不改**——
 * 这是「已发布必须写迁移」（AGENTS.md）的执行：别人机器上的数据只挪位置。
 *
 * 幂等性：指针指向有效用户目录时立即返回（不改指针）。如果需要补完成标记，也会写指针。
 * 可续跑性：中途被杀后下次启动能补搬剩余文件或补完成标记。
 * 防呆：users/ 存在但不是我们创建的，不动旧文件。
 * db 是 WAL 模式（db.ts），-wal / -shm 侧车里可能有未合并的提交，必须一起搬，
 * 否则最近的录音判定会静默丢失。
 */
export function migrateLegacyLayout(root: string, dataDir: string): boolean {
  // 如果指针已指向一个真实存在的用户目录，不改指针
  const currentUser = readCurrentUser(dataDir);
  const usersDir = usersDirOf(dataDir);
  if (currentUser !== null) {
    const userPath = join(usersDir, currentUser);
    if (existsSync(userPath) && statSync(userPath).isDirectory()) {
      return false;
    }
  }

  const legacyDb = join(dataDir, "index.db");
  const defaultUserDir = join(usersDir, DEFAULT_USER);

  // 全新安装（无旧 db 且无 users/）不迁移
  if (!existsSync(legacyDb) && !existsSync(usersDir)) return false;

  // 防呆：users/ 存在但不是我们创建的（users/默认/ 不存在），不动旧文件
  if (existsSync(usersDir) && !existsSync(defaultUserDir) && !existsSync(legacyDb)) {
    return false;
  }

  // 其他情况都尝试迁移（包括中途中断的续跑）
  mkdirSync(defaultUserDir, { recursive: true });
  const moves: Array<[string, string]> = [
    [legacyDb, join(defaultUserDir, "index.db")],
    [join(dataDir, "index.db-wal"), join(defaultUserDir, "index.db-wal")],
    [join(dataDir, "index.db-shm"), join(defaultUserDir, "index.db-shm")],
    [join(root, "review-state.json"), join(defaultUserDir, "review-state.json")],
    [join(root, "发音档案.md"), join(defaultUserDir, "发音档案.md")],
  ];
  let moved = false;
  for (const [from, to] of moves) {
    if (existsSync(from)) {
      renameSync(from, to);
      moved = true;
    }
  }

  // 写指针的两个条件之一成立就写：
  // 1. 真的搬了文件；
  // 2. 或者已有默认用户目录但指针没指向任何有效用户，且只有默认用户存在
  //    （避免在多用户场景中被强制拉回，让上层处理指针丢失的情况）
  let needsPointer = moved;
  if (!needsPointer && existsSync(defaultUserDir)) {
    const validUsers = listUsers(dataDir);
    // 走到这里 hasValidPointer 必然是 false：函数顶部那个早退分支已经拦掉了
    // 「指针指向一个真实存在的用户目录」的全部情况，而 listUsers 只列目录——
    // 这行是安全冗余，不是会命中的分支。
    const hasValidPointer = currentUser !== null && validUsers.includes(currentUser);
    if (!hasValidPointer && validUsers.length === 1 && validUsers[0] === DEFAULT_USER) {
      needsPointer = true;
    }
  }

  if (needsPointer) {
    writeCurrentUser(dataDir, DEFAULT_USER);
    if (moved) {
      console.log(`[users] 旧的单用户数据已搬进 data/users/${DEFAULT_USER}/，内容原样未动`);
    }
    return true;
  }
  return false;
}

/** 一个用户当前打开着的会话：自己的库句柄、复习进度、档案文件路径 */
export interface UserSession {
  name: string;
  db: Database.Database;
  review: ReviewStore;
  profileFile: string;
}

export interface UserManagerOptions {
  root: string;
  dataDir: string;
  /**
   * 每打开一个用户的库就跑一次（启动、每次切换）。index.ts 把领域仪式挂这里：
   * reanalyze / reconcile / 孤儿复习卡清理 / 档案统计同步。
   * UserManager 只管文件与句柄的生命周期，不认识 noteStore——边界在这。
   */
  onOpen?: (s: UserSession) => void;
}

/**
 * 管用户会话的生命周期：构造即完成迁移 + 解析当前用户 + 打开会话；之后负责切换和新建。
 * 不碰笔记归属、发音档案统计这类"打开一个用户之后该做什么"——那是 onOpen 的事。
 */
export class UserManager {
  private active: UserSession;

  constructor(private opts: UserManagerOptions) {
    migrateLegacyLayout(opts.root, opts.dataDir);
    const listed = listUsers(opts.dataDir);
    const wanted = readCurrentUser(opts.dataDir);
    const name = wanted && listed.includes(wanted) ? wanted
      : listed.length > 0 ? listed[0]
      : DEFAULT_USER;
    if (wanted && wanted !== name) {
      console.warn(`[users] 当前用户.txt 指向「${wanted}」但没有这个用户，回落到「${name}」`);
    }
    this.active = this.open(name);
  }

  current(): UserSession { return this.active; }

  list(): string[] { return listUsers(this.opts.dataDir); }

  switchTo(name: string): "ok" | "not-found" | "invalid" {
    if (invalidUserName(name) !== null) return "invalid";
    if (name === this.active.name) return "ok";
    // 跟 migrateLegacyLayout 同一条判据：users/ 下一个同名普通文件不算数，得是真目录
    const dir = join(usersDirOf(this.opts.dataDir), name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return "not-found";
    // 先开新库、成功了再关旧的：open() 抛出时（目标目录里的 index.db 不是合法
    // sqlite 文件、或文件被占用锁住）this.active 必须还站在原来那个能用的会话上，
    // 不然此后每个碰 deps.db 的端点都会 500，只能重启服务才能恢复。
    // open() 里 writeCurrentUser 排在 openDb 之后，所以开新库失败时磁盘指针
    // 也没被碰——这个顺序不能改。
    // 代价是旧库的句柄会比新库晚关一小会儿，WAL 侧车多摊一瞬——比留一块砖头强。
    const old = this.active;
    this.active = this.open(name);
    old.db.close();
    return "ok";
  }

  create(name: string): "ok" | "exists" | "invalid" {
    if (invalidUserName(name) !== null) return "invalid";
    const dir = join(usersDirOf(this.opts.dataDir), name);
    if (existsSync(dir)) return "exists";
    this.ensureFiles(name);
    // 空库也当场落盘：新建完还没切换过去时，目录里就该是完整的三件套之二
    openDb(join(dir, "index.db")).close();
    return "ok";
  }

  /** mkdir + 档案缺了从模板铺。铺模板不能交给 syncProfile——它只写统计块，手写节会整个丢 */
  private ensureFiles(name: string): void {
    const dir = join(usersDirOf(this.opts.dataDir), name);
    mkdirSync(dir, { recursive: true });
    const profile = join(dir, "发音档案.md");
    const template = join(this.opts.root, "发音档案.template.md");
    if (!existsSync(profile) && existsSync(template)) copyFileSync(template, profile);
  }

  private open(name: string): UserSession {
    this.ensureFiles(name);
    const dir = join(usersDirOf(this.opts.dataDir), name);
    const s: UserSession = {
      name,
      db: openDb(join(dir, "index.db")),
      review: new ReviewStore(join(dir, "review-state.json")),
      profileFile: join(dir, "发音档案.md"),
    };
    writeCurrentUser(this.opts.dataDir, name);
    // 库已经开好、指针已经写好——会话本身是有效的。onOpen 挂的是 reanalyze/reconcile
    // 这类领域仪式，跑挂了是「仪式失败」，不是「打开/切换失败」，不能让它们抛出去
    // 变成服务起不来或切换半途而废（跟 ReviewStore 构造函数不允许因非核心动作抛出同一条先例）。
    try {
      this.opts.onOpen?.(s);
    } catch (e) {
      console.warn(`[users] 打开用户「${name}」之后的回调失败（${(e as Error).message}），会话本身仍然可用`);
    }
    return s;
  }
}
