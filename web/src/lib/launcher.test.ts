import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 启动器：三个平台都得说中文，而 Windows 那个还得守住两条硬规则。
 *
 * ── 背景 ──
 *
 * `启动.cmd` 顶上记着两条实测出来的规则：必须 CRLF、必须纯 ASCII。第二条是因为
 * cmd.exe 按固定大小的块读批处理文件，跨块的多字节 UTF-8 字符会被劈开，后半行
 * 当命令执行——**而且断在哪取决于字节偏移**，加一行注释就能把故障挪走或招回来。
 *
 * 代价是：这个项目的用户全是中文母语者，Windows 用户却看到一屏英文，
 * 其中包括最要命的那句「没找到 Node.js，去 nodejs.org 装」。
 *
 * ── 现在的办法 ──
 *
 * 所有中文搬进 `scripts/msg/*.txt`（UTF-8），批处理里用 `type` 打出来。
 * 规则 2 管的是 cmd.exe **解析**批处理文件；`type` 不解析，它把文件字节直接
 * 吐给控制台，而 `chcp 65001` 已经让控制台按 UTF-8 读。两边都实测过：
 * `type` 一个 UTF-8 文件 → 中文干净；把 .cmd 本身改存 GBK → 「锟斤拷锟斤拷」。
 *
 * ── 这个文件守什么 ──
 *
 * 新办法带来一个新的断裂点：**.cmd 和 .txt 是两个文件，改名不会有人提醒你。**
 * 少一个 .txt，用户看到的就只有一句「系统找不到指定的文件」，别的什么都没有。
 * 所以这里把引用和文件对起来，两个方向都查。
 *
 * （放在 web/src/lib 是跟着 brand.test.ts 的先例走——那边已经在查
 * 启动.sh / 停止.sh 里的名字了。vitest 的 node 档扫的就是这个目录。）
 */
const root = join(import.meta.dirname, '..', '..', '..');
const CMD = ['启动.cmd', '停止.cmd'];
const MSG_DIR = join(root, 'scripts', 'msg');

const raw = (p: string) => readFileSync(join(root, p));

describe('Windows 启动器的两条硬规则', () => {
  it.each(CMD)('%s 只能是 ASCII——多字节字符会被 cmd.exe 按块劈开', (f) => {
    const bad = [...raw(f)].filter((b) => b > 127);
    expect(bad, `${f} 里有 ${bad.length} 个非 ASCII 字节`).toHaveLength(0);
  });

  it.each(CMD)('%s 只能是 CRLF——LF 会让 cmd.exe 吃掉每行开头一两个字符', (f) => {
    const b = raw(f);
    const lf = [...b].filter((x) => x === 0x0a).length;
    const crlf = b.toString('latin1').split('\r\n').length - 1;
    expect(crlf, `${f} 有 ${lf - crlf} 行是裸 LF`).toBe(lf);
  });
});

describe('批处理引用的中文文件必须真的在', () => {
  const referenced = new Set<string>();
  for (const f of CMD) {
    for (const m of raw(f).toString('ascii').matchAll(/type\s+scripts\\msg\\([\w-]+\.txt)/g)) {
      referenced.add(m[1]);
    }
  }
  const onDisk = new Set(readdirSync(MSG_DIR).filter((n) => n.endsWith('.txt')));

  it('引用了就得存在——少一个，用户只会看到「系统找不到指定的文件」', () => {
    const missing = [...referenced].filter((n) => !onDisk.has(n));
    expect(missing, `批处理引用了但磁盘上没有：${missing.join('、')}`).toEqual([]);
  });

  it('存在了就得有人用——没人引用的提示文件是死文件', () => {
    const orphan = [...onDisk].filter((n) => !referenced.has(n));
    expect(orphan, `没有任何批处理引用它：${orphan.join('、')}`).toEqual([]);
  });

  it('至少得引用到几个，别是正则没匹配上还一片绿', () => {
    expect(referenced.size).toBeGreaterThanOrEqual(8);
  });
});

describe('「怎么停下来」必须有人说，而且只说一次', () => {
  /**
   * 这句话原来只写在 `启动.cmd` 的**已构建过**那个分支里，于是**第一次启动的人
   * 根本看不到**——而那正是唯一需要被告知的一次。macOS / Linux 的启动脚本更彻底：
   * 两个分支都没有，只在停了之后说一句「服务已停止」，那时候说已经没意义了。
   *
   * 现在挪进服务自己的启动输出（server/src/index.ts），一处覆盖三个平台、两个分支。
   *
   * 这是一条**读源码文本**的断言，不是行为断言——index.ts 是带副作用的入口文件，
   * 真跑起来验要先构建，而测试跑在源码上。它拦的是"这行被删掉了没人发现"，
   * 那正是这次的故障模式：三个启动脚本都不说，就没有任何地方兜底。
   */
  const STOP_HINT = /要停下来|关掉这个窗口/;

  it('服务起来时自己说得出怎么停', () => {
    expect(raw('server/src/index.ts').toString('utf8')).toMatch(STOP_HINT);
  });

  it('启动脚本里不再重复说——一件事只有一个说法', () => {
    const dup = ['scripts/msg/starting.txt', 'scripts/msg/first-run.txt',
      '启动.command', '启动.sh']
      .filter((f) => STOP_HINT.test(raw(f).toString('utf8')));
    expect(dup, `这些地方又说了一遍：${dup.join('、')}`).toEqual([]);
  });
});

describe('三个平台的用户都得看到中文', () => {
  const HAN = /[一-鿿]/;

  it.each([...readdirSync(MSG_DIR)])('scripts/msg/%s 是合法 UTF-8 而且真有中文', (n) => {
    const b = readFileSync(join(MSG_DIR, n));
    // fatal 模式：不是合法 UTF-8 就抛，而不是悄悄替换成 U+FFFD
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    expect(text.trim(), '空文件').not.toBe('');
    expect(text, `${n} 里一个汉字都没有`).toMatch(HAN);
  });

  it.each(['启动.command', '停止.command', '启动.sh', '停止.sh'])(
    '%s 的中文直接写在里面——bash 原生读 UTF-8，不受那两条规则限制',
    (f) => {
      expect(raw(f).toString('utf8')).toMatch(HAN);
    },
  );
});

/**
 * 上手路径上不许把「会自动下模型」说成无条件的事。
 *
 * 逐音素评测靠一个由 `uv` 拉起的本机 Python 服务。**没装 uv 就没有下载、
 * 也没有进度条**——窗口里出现的是 check-uv.mjs 那段安装说明。而全新的
 * Windows 用户几乎不可能装过 uv，也就是说这句话对大多数人第一次启动时是假的。
 *
 * 它前后在三个地方出现过（README、first-run.txt、starting.txt），说明还会回来。
 * 所以扫的是**用户在装好之前会读到的那几份**，不是某一句具体措辞。
 */
describe('别把「自动下模型」说成无条件的', () => {
  const 上手路径 = ['README.md', 'scripts/msg/first-run.txt', 'scripts/msg/starting.txt'];
  const 提到下模型 = /(下|加载|载入)[^\n]{0,20}模型/;

  it.each(上手路径)('%s 提到下模型的地方，附近必须交代它要 uv', (f) => {
    // **按段落看，不按句子**：前提常常写在同一段的前一句里（README 那节的标题
    // 就是「逐音素评测的边车（上面第 3 步说的 uv）」）。第一版按句号切，
    // 把这种正当写法误报成了打包票。
    const 段落 = raw(f).toString('utf8').split(/\n\s*\n/);
    for (const p of 段落) {
      if (!提到下模型.test(p)) continue;
      expect(
        /uv|Python|要一个/.test(p),
        `${f} 这一段把下模型说成了无条件的：\n${p.trim()}\n`
        + '没装 uv 的话不会有任何下载、也没有进度条，窗口里出现的是安装说明。',
      ).toBe(true);
    }
  });
});

/**
 * 界面上让人「双击某个文件」时，那个文件必须真的在仓库里。
 *
 * 踩过：设置页写着「双击『正音 · 停止』」，而仓库里叫 停止.cmd / .command / .sh，
 * **没有任何东西叫那个名字**。照着做的人找不到，只会以为自己装漏了。
 */
describe('界面让人双击的文件，仓库里得真有', () => {
  const 提到双击 = /双击[^。\n]{0,40}/g;

  it.each(['web/src/pages/SettingsPage.tsx', 'web/src/components/Offline.tsx', 'README.md'])(
    '%s 提到的启动/停止文件名都存在',
    (f) => {
      const text = raw(f).toString('utf8');
      const 文件名 = new Set<string>();
      for (const m of text.matchAll(提到双击)) {
        for (const n of m[0].matchAll(/(启动|停止)[\w.]*/g)) 文件名.add(n[0]);
      }
      for (const n of 文件名) {
        // 只写「启动」「停止」两个字（泛指那一组文件）是允许的；带扩展名就得对得上
        if (!n.includes('.')) continue;
        expect(existsSync(join(root, n)), `${f} 让人双击 ${n}，但仓库里没有这个文件`).toBe(true);
      }
    },
  );
});

/**
 * 启动器结束时那句话，在「它本来就在跑」那一支上也得是真的。
 *
 * ── 踩到的 ──
 *
 * 服务发现端口被自己占着时，打的是「正音已经在 http://… 上跑着了，直接打开就行」
 * 然后 **exit 0**。而 exit 0 在启动器那边走的是"正常结束"分支，打的是
 * 「**已经停了**。按任意键关掉这个窗口。」——说它在跑，紧接着说它停了，
 * 照着读的人会以为自己刚把它关掉。
 *
 * ── 为什么不用退出码区分 ──
 *
 * 试过：让"已经在跑"退 3、启动器按 errorlevel 分三支。**concurrently 把它压成了 1**
 * （实测 exit 0→0、1→1、3→**1**），而 `npm start` 正是 concurrently 起的。
 * 退出码穿不过来，这条路是死的。
 *
 * 所以改成让那句话在两种 exit 0 下都成立：只说"窗口可以关了"，不断言服务的状态。
 * 服务自己的输出已经把状态说清楚了，启动器不该再猜一遍。
 */
describe('结束语不许断言服务的状态', () => {
  const 收尾 = ['scripts/msg/stopped.txt', '启动.command', '启动.sh'];

  it.each(收尾)('%s 不说「已经停了 / 服务已停止」', (f) => {
    // 跳过 # 注释：.command / .sh 里那两行注释正是在解释这条规矩，
    // 连它们一起查的话，写清楚理由反而会让守卫变红。
    const text = raw(f).toString('utf8')
      .split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
    // 只看正常结束那一支：failed.txt 说"没能起来"是对的，停止脚本说"已经停了"也是对的
    const 断言状态 = /(已经停了|服务已停止|已停止)/;
    expect(断言状态.test(text), `${f} 断言了服务的状态，而 exit 0 也可能是"它本来就在跑"`)
      .toBe(false);
    expect(text, '收尾那句连关窗口都不说了').toMatch(/关(掉|闭)/);
  });

  it('前提：服务真的会说「已经在跑着了」，不然这条守卫是空的', () => {
    expect(raw('server/src/index.ts').toString('utf8')).toMatch(/已经在.*跑着了/);
  });
});
