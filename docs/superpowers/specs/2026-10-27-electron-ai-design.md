# 正音桌面版 + AI 讲解 · 设计

把「正音」从双击启动器 + 浏览器，改成 Windows 桌面应用，并在应用里接上 AI：
讲解、写笔记、助教对话、以及一个能读写本机笔记与发音档案的命令行代理。
AI 服务商清单由 `web-tools-by-ai` 的 provider 目录同步下发，用户既可以填接口，
也可以用本机已经装好的 AI CLI。

这份文件是实施前的正本。改动落到代码之后，`AGENTS.md` 与 `README.md` 里会变假的
句子要同一批改口（清单见「文档改动」一节）。

## 目标与不做的事

**要做的**

1. Windows x64 桌面应用：窗口、单实例、原生菜单、自动更新、安装版与免安装版。
2. 音素识别服务由主服务接管：`npm start` 与桌面版都不再靠 concurrently 另起一个进程，
   退出时连带停掉，不再留一个占着模型的孤儿 Python。
   开发模式（`npm run dev`）仍单独跑边车，理由见「音素识别服务的生命周期」。
3. AI 四项能力：讲解当前词／这次录音、把讲解存成本机笔记、AI 助教对话、
   命令行代理整理（写笔记 + 更新发音档案）。
4. AI 服务商目录从 `web-tools-by-ai` 同步；接口模式支持 OpenAI 兼容、
   Anthropic、Gemini 三种协议；命令行模式支持 claude / codex / gemini / agy / 自定义。
5. 浏览器模式（`npm start` / `npm run go` / 双击启动器）继续可用，
   和桌面版共用同一份服务端与前端代码。

**首发不做的**

- macOS / Linux 桌面版。
- 流式回复。三套协议统一等完整响应，界面显示已用时与取消；命令行代理的日志是流式的。
- 把 Python 运行时和 1.2GB 模型打进安装包。
- 接口模式直接写文件。写文件只有命令行代理那条路（接口没有文件系统）。
- AI 设置跨设备同步；AI 设置与对话历史都不进 `/api/backup`。
- 托盘常驻。关窗口就是退出（这个应用没有「必须在后台响」的事）。

## 架构：服务端统一编排

Electron 主进程只做四件事：算路径、起停子进程、开窗、原生菜单与更新。
AI、识别服务、笔记读写、数据库全在现有的 Hono 服务里；前端仍然只是渲染服务端算好的东西。

理由：

- 浏览器模式和桌面版共用一套实现。把 AI 放进主进程走 IPC，等于同一套上下文组装、
  密钥管理、错误映射写两遍，而浏览器版永远拿不到 AI。
- 密钥不出服务进程，界面上只有打码回显；这条跟现有的 MW key 一致。
- 服务端可以用纯函数 + 假 fetch/假 spawn 完整测试，主进程那部分只剩路径和进程管理。

代价：主服务进程变大，长请求要自己做超时与取消。这两条都在下面写死了判据。

### 进程模型

```
Electron 主进程（desktop/dist/main.js）
  └─ 随包 node.exe  →  server/dist/index.js        （Hono，动态端口，绑 127.0.0.1）
        └─ 随包 uv.exe  →  Python / uvicorn 边车   （音素识别，动态端口，绑 127.0.0.1）
```

- 服务用**随包的 `node.exe`**，不用 Electron 自带的 Node。
  决定性理由是 `better-sqlite3` 是原生模块：它的 `.node` 按 Node ABI 编译，
  在 Electron 的 Node 里加载不了；而给它按 Electron ABI 重编，等于把服务
  和 Electron 的版本绑死，每次升 Electron 都要重编一次。
  随包一份 Node 之后，桌面版和浏览器模式跑的是同一种运行时、同一个预编译二进制。
- 构建时按固定版本下载 `node.exe` 与 `uv.exe` 到 `desktop/vendor/`（不进版本库），
  连同各自的 LICENSE 一起进 `extraResources`。版本与校验和写死在下载脚本里。
- 关窗口 = 退出：主进程先停服务子进程，服务自己停边车（按进程树杀，见下）。
- 麦克风权限显式设 `setPermissionRequestHandler`：只放 `media`，其余拒绝。
  不依赖 Electron 的默认行为——默认行为是什么，本仓没有先例可引，
  冒烟清单里要真录一次音。
- 服务子进程的 stdout/stderr 全部落 `<userData>/logs/server.log`（超过上限就滚动），
  并在内存里留最后 40 行给错误对话框用。桌面版没有控制台，
  不落文件就等于「起不来时什么都看不到」。
- 起不来的三种情况分开说，不合成一句「启动失败」：
  探活超时（窗口里给一句人话 + 日志路径，不留白屏）、
  spawn 就失败（没有退出码，只有 errno：文件不在 / 系统拒绝创建进程，多半被安全软件拦）、
  起来之后又退了（给退出码）。这三种的处置法各不相同，混成一句用户无从下手。

### 端口

- 主服务：浏览器模式仍是 30031（`.env` 的 `PORT` 可改）；桌面版启动时挑一个空闲端口传进去。
  前端全部用相对路径，`brand.ts` 的 `localAppUrl()` 从 `location.port` 取端口，动态端口安全。
- 边车：不再写死 30032。服务启动时决定端口并同时告诉 Python 和自己的客户端
  （`server/src/audio/phonemeAsr.ts` 里那个模块级常量要改成读运行时端口）。
  `ASR_PORT` 显式给了就固定用它。
- 两者都绑 `HOST`（默认 `127.0.0.1`）。现在服务是绑在所有网卡上的
  （`@hono/node-server` 的 `server.listen(port, options.hostname)`，hostname 未传），
  而 AI 密钥与「能写文件的代理」都挂在它上面，必须收成本机。
  `HOST=0.0.0.0` 仍可显式放开，代价写在 README。

## 运行时路径

两个根，各管一件事：

| 变量 | 含义 | 浏览器模式默认 | 桌面打包版 |
|---|---|---|---|
| `SHIPPED_ROOT` | 随应用发布的只读资产 | 仓库根（现有推断） | `<resources>` |
| `APP_ROOT` | 可写的用户根 | 仓库根 | `<userData>/app`，或首启向导选的旧文件夹 |

桌面版另外传三样：`NO_OPEN=1`（不弹浏览器）、`APP_RUNTIME=desktop`、`APP_VERSION`。
后两个是 `GET /api/runtime` 的数据来源——界面文案要按它分叉（见后），
而服务端自己判断不出来「我是在 Electron 里跑的」。

由这两个根派生，每一项都可以单独用环境变量覆盖（测试要用）：

| 派生 | 位置 |
|---|---|
| `DATA_DIR` | `<APP_ROOT>/data` |
| `.env` | `<APP_ROOT>/.env` |
| 随附笔记（只读） | `<SHIPPED_ROOT>/notes` |
| 本机笔记（可写，AI 写这里） | `<APP_ROOT>/data/notes` |
| 旧文件夹笔记 | `<APP_ROOT>/notes`，仅当它不等于随附笔记根 |
| 前端构建产物 | `<SHIPPED_ROOT>/web/dist` |
| AI 提示词正本 | `<SHIPPED_ROOT>/workflows` |
| 边车工程 | `<SHIPPED_ROOT>/asr-service` |
| 发音档案模板 | `<SHIPPED_ROOT>/发音档案.template.md` |
| 备用模型清单 | `<SHIPPED_ROOT>/scripts/vosk-models.json` |
| 代理参考副本 | `<APP_ROOT>/.ai-reference/` |

模板和备用模型清单以前是从 `root` 读的，桌面版必须改读 `SHIPPED_ROOT`：
`<APP_ROOT>` 在安装场景下是一个空的用户目录，那里没有这两个文件。
漏掉的后果跟 035 漏 `chinese-days` 一样——包打得出来、CI 全绿，装出来点开才炸。

`userData` 显式设成 `%APPDATA%\zhengyin`（ASCII），显示名仍是「正音」。
理由跟 035 一样：Electron 默认按 productName 建目录，而服务端自己的数据目录
按 ASCII 名走，不对齐就会并排躺两个文件夹，看着像装了两个应用。

### 首启向导

用原生对话框，不做网页向导：

1. 「使用已有的正音数据」→ 选目录。校验它像不像正音的数据根
   （含 `data/` 或 `notes/` 或 `发音档案.template.md`），不像就明说并让重选。
   选中之后**直接作为 `APP_ROOT`，不复制、不移动**；旧的 `data/`、`.env`、`notes/` 原样继续用。
2. 「导入备份文件」→ 选 `/api/backup` 导出的 JSON。先用全新 `APP_ROOT` 起服务，
   起来之后 POST 进去。备份里没有发音档案和笔记，界面上要如实说，
   并指回第 1 条（有旧文件夹就选旧文件夹）。
3. 「全新开始」→ `APP_ROOT = <userData>/app`。

选择记在 `<userData>/desktop-settings.json`（不在 `APP_ROOT` 里——它可能指向别处）。
原生菜单里给「更换数据文件夹…」，改完重启生效。

### 数据锁

`<DATA_DIR>/.lock` 写 pid、主机名、启动时刻。启动时若锁存在且那个 pid 还活着
（`process.kill(pid, 0)`），拒绝启动并说清是谁占着；进程不在了就是残锁，接管。
退出时删自己的锁。

存在理由：首启向导允许把 `APP_ROOT` 指到仓库文件夹，而那正是 `npm start`
在用的目录。两个进程同时写 `review-state.json`、发音档案和 SQLite，
坏法没有任何提示。加了锁之后表现是一句能照做的中文。

实施时要顺手核一遍现有测试：锁是按数据目录生效的，
凡是「同一个目录开两次服务」的用例都会开始红，那是用例要改，不是锁要撤。

## 笔记：三根，固定优先级

`NoteStore` 现在是单根实现（构造参数一个 `dir`，`Note.file` 存的是裸文件名，
id 冲突的告警原话是「谁生效取决于文件系统的目录读取顺序，不保证稳定」）。
改成多根，优先级从低到高：

1. **随附笔记** `<SHIPPED_ROOT>/notes` — 应用只读，随应用更新。
2. **旧文件夹笔记** `<APP_ROOT>/notes` — 只在首启选了旧文件夹、且它不等于随附笔记根时存在。
3. **本机笔记** `<APP_ROOT>/data/notes` — 可写，AI 写的笔记落这里。

「应用只读」说的是应用自己不往那儿写。浏览器模式下随附根就是仓库的 `notes/`，
写它的人仍然是外部编码代理（现有工作流不变），写完照常提交。

同一个 `id` 高优先级胜出，且这是**确定的**，不再依赖目录读取顺序；
冲突告警要改口说清「哪一根赢了、为什么」。`Note.file` 改成能定位到具体文件
（绝对路径或「根 + 文件名」），界面上给笔记加一个来源标记（随附 / 本机），
用户才知道哪几篇是自己机器上长出来的。

`id` 来自 frontmatter，不是文件名（现有笔记是 `aa-vs-ae`、`kl-cluster` 这种）。
所以「存为笔记」必须生成并写入 `id:`，文件名另按 `<音或词>-<中文描述>.md` 的既有约定；
id 撞了就在写入前避开，而不是靠 NoteStore 事后告警。

`watch()` 要同时看三个根；某一根不存在不报错。

## 音素识别服务的生命周期

服务启动时自己决定边车的去留：

1. `ASR_AUTOSTART=0` → 不自己起，只按 `ASR_PORT`（默认 30032）探状态。
   开发模式用这条：`npm run dev` 仍由 concurrently 单独跑 `npm run asr`，
   否则 tsx watch 每次重启都要重新加载一遍模型。
2. 否则先探 `ASR_PORT` 上**有没有东西在听**。有就接管，不起第二个。
   判据不能是 `/health` 的 `ok`：模型加载期间端口已经在听、而 `/health` 回 `ok:false`
   （`phonemeAsr.ts` 自己写着这条）。按 ok 判就会在边车还在加载时又起一个 Python，
   两份 1.2GB。
3. 都没有就起一个：`ASR_PORT` 没给就挑空闲端口；给了却被别的程序占着，
   **明确报错、不静默换端口**——用户写死了端口却跑在另一个上，
   比一句报错难查得多。启动用 `UV_PATH` 指的 uv。

启动命令与环境（每一项都有实测依据，不是保险）：

```
uv run --frozen --project <SHIPPED_ROOT>/asr-service \
       uvicorn main:app --app-dir <SHIPPED_ROOT>/asr-service \
       --host 127.0.0.1 --port <port>
```

- `UV_PROJECT_ENVIRONMENT`、`UV_CACHE_DIR`、`UV_PYTHON_INSTALL_DIR` 全部指到 `APP_ROOT` 下：
  安装目录可能只读，venv、缓存、下载的 Python 都不能落在那儿。
- `PYTHONPYCACHEPREFIX` 必须设。实测：只读工程目录 + 上面三个变量 + `--frozen`，
  程序跑通且工程目录**新增 0 个文件**；把 `PYTHONPYCACHEPREFIX` 去掉，
  `__pycache__/mod.cpython-*.pyc` 就写进工程目录。仓库里现有的
  `asr-service/__pycache__/main.cpython-311.pyc` 是同一件事的现场证据。
- `--frozen` 依赖 `uv.lock` 与 `pyproject.toml` 同步；`uv lock --check` 要进 CI，
  否则每个用户的边车都会在启动时报一句跟他无关的锁文件错。
- 沿用现有的 `PYTHONIOENCODING=utf-8`、`DISABLE_SAFETENSORS_CONVERSION=1`，
  以及 `.env` 里的 `MODEL_SOURCE` / `HF_ENDPOINT`（现在由服务读出来传给子进程，
  不再需要 `scripts/asr.mjs` 那层包装来搬运 `.env`）。
- 模型缓存仍用系统默认位置，不重定向：已经下过的人升上来一个字节都不该重下。
  界面上把缓存路径显示出来。

状态机只留诚实的几档：`off`（AUTOSTART=0）/ `no-uv` / `starting` / `ready` / `error`，
外加最近 300 行日志。不猜「正在装依赖」还是「正在下模型」——日志里有原话，
界面把日志摊开比编一个进度条诚实。`GET /api/asr/status` 给状态与日志，
`POST /api/asr/restart` 重试。

`scripts/asr.mjs` 与 `preasr`（`scripts/check-uv.mjs`）都留着：开发模式仍由
concurrently 单独跑边车，那条路上「没装 uv 就给一段能照做的中文」的守卫照旧有用。
变的只是 `npm start` 不再经它。

退出与崩溃：按进程树杀。Windows 用 `taskkill /T`，POSIX 用 detached + 杀进程组。
uv 之下还有一层 Python，只杀 uv 会留下一个占着模型的孤儿。
`npm start` 的语义随之改变（只起服务，边车由服务带），
设置页那句「刻意不做网页上关服务的按钮，因为关不掉识别服务」的理由同时作废。

`AsrStatus` 不再说「看一眼启动时打开的那个黑窗口」——桌面版没有黑窗口，
浏览器模式也改成就地展开日志。两个模式用同一份文案，不给运行时分支。

## AI provider 目录

- 上游 `web-tools-by-ai/scripts/sync-provider-catalog.ts` 的 `CONSUMERS` 加一条本仓路径，
  生成物落在 `web/src/vendor/providerCatalog.generated.ts`，进版本库、永不手改。
- **先建 `web/src/vendor/` 目录再跑同步**：脚本对不存在的父目录只打一行 warn 就跳过，
  不报错。
- 消费层 `web/src/lib/aiPresets.ts` 从目录派生服务商芯片、区域端点、默认模型、
  模型候选、hidden 订阅套餐、keyOptional。只取 `protocol` 为
  `openai` / `anthropic` / `gemini` 的行，其余（yandex、azure-openai）在界面上不出现；
  已经存着的记录若协议不在支持集，界面明说「这一家的协议本应用不支持」，不静默失败。
- `gemini-openai`（上游为「只讲 Chat Completions 的消费方」合成的那行）不展示，
  本仓有原生 Gemini 适配，展示两行 Google 只会让人猜该选哪个。
- `.gitattributes` 给 `*.generated.ts` 钉 `text eol=lf`。不做全仓 `* text=auto`
  归一化——那会让每个克隆重新检出全部文本文件，换不来任何东西。
- 目录是跨仓拷贝，所以要有守卫：一条测试断言生成物存在、含 claude / gemini 行、
  且 web 侧支持的协议集与服务端适配器的协议集**逐字相同**
  （两份清单分处两个包，漂开的表现是「界面能选、服务端说协议不认识」）。

## AI 设置

存在 `<DATA_DIR>/ai-settings.json`（机器级，不进备份）：

```json
{
  "schemaVersion": 1,
  "mode": "api",
  "endpointId": "deepseek",
  "endpoints": {
    "deepseek": { "protocol": "openai", "baseUrl": "https://…/chat/completions", "key": "…", "model": "…" }
  },
  "cli": { "kind": "claude", "path": "", "customArgs": "" },
  "consent": true
}
```

- `protocol` 存在记录里，由界面从目录写进来。服务端不读目录（目录在 web 包里），
  所以协议是记录的一部分；服务端只认这三个值，其余一律拒。
- 一家一条记录，一个账号一把钥匙；地域端点是同一条记录里的地址候选。
  换服务商就是换记录，密钥跟着记录走，不从别家搬。
- GET 只回打码密钥；保存时打码回显等于「没动密钥」。
  地址换到另一台主机时清空密钥（判据沿用 035：`PUT` 的整份覆盖 + 打码回显 + origin 比较），
  界面在保存**之前**就把这句话说清楚。
- **密钥不是必填项**。本机 Ollama / LM Studio 这类不要钥匙；目录的 `keyOptional`
  是 provider 级事实，而且 `llm` 那组把 Together / Fireworks 也标成 keyOptional
  （其实要钥匙），拿它当判据会两头都错。服务端只必填地址与模型，
  密钥空着就发，由 401/403 的中文错误兜；界面按目录给「这家通常要密钥」的提示。
- `consent` 是服务端强制的闸，不是装饰：没确认过，**会真的把数据发出去的那几个接口**
  （讲解、笔记草稿、对话、代理运行、测试连接）一律 409，并说清
  「使用 AI 会把发音档案、相关笔记和这次的错误发给你选的服务」。
  首次进 AI 界面时问一次。
  读写设置与查状态**不受这道闸挡**——挡住它们就等于不让人先去配置，
  那道闸自己也永远解不开。
- **为什么 MW key 在 `.env` 而 AI 设置在 JSON**：MW key 是既有的单值配置，
  搬走要写迁移（已发布的应用，别人机器上有那份文件）；AI 设置是新的、
  而且天生是「一张表 + 选中哪一条」，塞进 `.env` 只会发明一套自己的分隔符语法。
  两者都在 `APP_ROOT` 之下、都不进版本库、都不进备份。

## AI 调用

### 接口

三个适配器 + 一个统一入口，全部非流式：

| 协议 | 地址 | 凭据 | 取文本 |
|---|---|---|---|
| openai | 归一到 `…/chat/completions` | `Authorization: Bearer` | `choices[0].message.content`（字符串或 text 部件数组都认） |
| anthropic | 归一到 `…/v1/messages` | `x-api-key` + `anthropic-version` | `content[]` 里 `type:"text"` 的部件（跳过 thinking 块） |
| gemini | `<base>/models/<model>:generateContent` | `?key=` | `candidates[0].content.parts[].text` |

- 地址归一要认三种填法（完整动作地址 / 到版本路径 / 光域名），
  光域名时补的是带 `/v1` 的完整路径——补错会 404，而 404 里看不出少的是哪一段。
- Gemini 的密钥在 query 上，所以**所有**错误消息与日志都要先过一遍脱敏
  （去掉 `key` / `api_key` 查询参数，去掉 Authorization 值）。
- 请求体只放必需字段。不发 `temperature`，不发思考参数：档位是各家的私事，
  目录里的 `thinkingWire` 这一版不接，界面上也不摆档位——摆一个不发的档，
  就是「界面显示的档和实际跑的档不是一档」。
- 超时：测试连接 30s，讲解/对话/笔记草稿 180s。取消用 `AbortController`，
  用户点取消要真的断开上游，不是只在界面上收起来。
- 错误映射成中文并带上完整地址：401/403 密钥被拒、404 地址路径不对、
  429 频率或额度、5xx 服务商故障、连不上、超时。原始英文错误放在下一行，
  不吞掉——猜错了比不猜更坏。

### 命令行

| kind | 只出文字 | 代理（可写） | 取结果 |
|---|---|---|---|
| claude | `-p <prompt> --tools "" --permission-prompts none --output-format json` | `-p <prompt> --allowedTools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits --permission-prompts none --output-format json` | JSON 的 `result` |
| codex | `exec --sandbox read-only --skip-git-repo-check -o <file> <prompt>` | `exec --sandbox workspace-write --skip-git-repo-check -o <file> <prompt>` | 读 `-o` 那个文件 |
| gemini | `-p <prompt> --approval-mode plan -o json` | `-p <prompt> --approval-mode auto_edit -o json` | JSON 里的回复字段 |
| agy | `-p <prompt>` | `-p <prompt> --mode accept-edits --dangerously-skip-permissions` | stdout |
| custom | 用户给的参数模板，`{prompt}` 占位；没写就追加 | 同左 | stdout |

- `claude --tools ""` 是官方 help 里写明的「禁用全部工具」，所以只出文字那条路
  是真的没有文件权限，不是靠提示词请求它别动。
- 一律用 `cross-spawn`，不用 `shell:true`：Windows 上 npm 装的 CLI 是 `.cmd` shim，
  原生 spawn 叫不起来，而 `shell:true` 不转义 argv，提示词里一个 `&` 就能注入命令——
  提示词里拼的是用户自己的录音转写和档案内容，不是可信字符串。
  `cross-spawn` 及其运行时依赖要进 extraResources。
- 命令存在性检查按 `cross-spawn` 的解析规则来（`.exe` / `.cmd` / `.bat` 都算找得到），
  否则状态说「已接上」、点下去起不来。
- 「已找到命令」不等于「登录了」，所以设置页的测试按钮要真跑一次最小提示词，
  把 CLI 自己的报错原样透出来。
- 输出解析失败一律回落到原始 stdout（去 ANSI），不因为解析不出来就说 AI 失败。
- codex 的 `-o <file>` 写系统临时目录、读完即删，**不要落在 `APP_ROOT` 里**：
  代理那次的越界检测会把我们自己写进去的临时文件当成「AI 改了不该改的东西」。
- 讲解 / 对话 / 存草稿各自一把 in-flight 锁：CLI 模式每点一次就是一个真进程、
  一次真额度，双击就是两个。

## AI 的四项能力

### 提示词正本

`workflows/coach.md`（讲解、对话、笔记草稿共用）与 `workflows/agent.md`（代理整理）。
接口模式由服务端读进来拼进提示词；命令行代理模式让 CLI 自己读同一个文件。
**规则只有这一份**，两边各写一份必然漂，而漂开的表现是「同样一个问题，
接口和命令行给出不同口径的讲解」，界面上没有任何地方提示这种分叉。

内容要点（正本里写全）：中文作答、一律美音、落到可执行的身体动作、
不写「多听多练」这种废话、不编造用户没有的数据、
笔记只写知识不写个人断言、不写 severity、讲音写 triggers 讲词写 words、
错法写 contrasts。这些跟 `AGENTS.md` 的既有约定同源，不是新发明的一套。

### 上下文组装

一个 `buildContext`，四项能力共用，按用途裁剪：

- 发音档案：手写部分 + AUTO 统计块（最常犯的音素错误表、该补的笔记、卡住的词）。
- 词条：音标、逐音素、音节与重音、标签。
- 这次录音：最近一次该词的评测（目标 IPA、听到的 IPA、逐处错、跟什么比的）。
  没有录音就按词本身讲，界面上说清是哪种。
- 相关笔记：按现有判据（`matchNotes` / `notesCovering` / `bestExplainers`）取，
  **最多 3 篇全文** + 全部笔记的标题与范围索引。**判据不在 AI 这一层另写一份。**
- 错误音素的客观发音要点（`articulation.ts`）。
- 库里没有这个词、或一次录音都还没有时，上下文照给（档案 + 词条分析 + 相关笔记），
  按词本身讲，不报「没有数据」——第一次用的人正是最需要讲解的那个。

所有上限集中在一个常量表里，各写一行理由：相关笔记全文 3 篇、
对话历史落盘保留 100 条 / 每轮带最近 20 条、`ai-runs` 快照保留 10 次、
边车日志环形缓冲 300 行。数字本身不神圣，但**只能在一处改**，
散在各处就会各调各的。

### 讲解

词条页一个 `AiCoach` 面板：`POST /api/ai/explain`，返回 markdown 与「参考了哪几篇」。
未配置 AI 时，面板整个换成一张「还没接上 AI」的卡——说清有接口和命令行两条路、
给设置页入口，**不做一颗点下去才失败的按钮**。
词典里查不到的词（没有逐音素归属）不给这颗按钮，那是条死路。

### 存成笔记

`POST /api/ai/note-draft` 让 AI 返回结构化草稿（标题、scope 是讲音还是讲词、
取值、contrasts、正文），**frontmatter 由服务端拼**，不让 AI 自己写 YAML。
解析用容错的 JSON 抽取（围栏、前后闲话、包了一层单键对象都要认）。

界面上是一个可编辑的表单：标题、范围（讲这个音 / 讲这个词，取值可增删）、
contrasts、正文（markdown + 预览）。保存走 `POST /api/notes`，
校验复用现有的 `validateTriggers` / `validateShape`：自检法与对比训练缺一节就拒，
并说清缺哪一节；trigger 用了形近字符（ASCII `g` 与 IPA `ɡ`）时给出「是否想用」。
写入本机笔记根，写完 `NoteStore` 重扫、`reconcileAttempts`、`syncProfile`，
词条页立刻能看到新笔记挂上来。

表单上要写明：笔记对这台机器的所有使用者可见，只写知识、不写个人诊断。

### 助教对话

`/assistant` 页。服务端保存当前用户最近 100 条消息
（`<DATA_DIR>/users/<名字>/ai-chat.json`），每轮带上最近 20 条，
由服务端自己读历史拼上下文，不采信客户端回传的整份历史。支持清空。
命令行模式每条消息重启一次 CLI，界面上把这件事说出来，不让人以为是同一次会话在延续。

上下文检索：消息里出现的、库里真有的词 → 带上它的分析与错误；
消息里出现的 IPA 符号 → 带上讲这个音的笔记；再带一份档案统计摘要。
不做向量检索，这一版用不上。

### 代理整理

`/organize` 页，仅命令行模式（接口没有文件系统）。界面在接口模式下直说这一点，
并给「切到命令行模式」的入口，不做一颗按下去才报错的按钮。

三种任务：按「该补的笔记」整理发音记录、按数据更新发音档案的手写两节、自定义。
运行前确认一次，确认框里逐条列出它**能改什么**（本机笔记、当前用户的发音档案）
和**不能改什么**（词条库、录音记录、复习进度、随附笔记）。

- 代理 cwd = `APP_ROOT`；随附笔记与 workflows 在 `SHIPPED_ROOT`，
  不在 cwd 之下，而四家 CLI 的跨目录授权方式各不相同
  （claude `--add-dir`、codex 的 `--add-dir` 语义是**可写**、gemini `--include-directories`、agy 未知）。
  所以启动时把随附笔记与 workflows 复制到 `<APP_ROOT>/.ai-reference/`，
  每次启动刷新，提示词里说明它是只读参考。跑完的 diff 若发现它被改动，按越界处理。
- 提示词里给出当前用户名与他的发音档案路径——`APP_ROOT` 下可能有好几个用户，
  不给名字就等于让它自己挑一个。
- 跑之前快照：当前用户的发音档案、本机笔记整棵树。跑完给变更清单
  （新增 / 修改 / 删除），并提供「撤销这次整理」——删掉新增的、还原被改的，
  然后重扫笔记、重算归属、同步档案。快照与撤销记录留在 `<DATA_DIR>/ai-runs/<时刻>/`，
  只保留最近 10 次。
- 越界检测：对 `data/` 下允许清单之外的文件比 mtime 与哈希（跳过音频与模型目录），
  发现改动就明确告警「这些文件不该被改」，并说清撤销**不能**还原数据库。
  做不到真沙箱，就把它说出来，不假装做到了。
- 跑完把 `NoteStore` 的告警一并回给界面：代理写出来的笔记同样要过
  `validateTriggers` / `validateShape`（坏 trigger、缺自检法或对比训练、
  正文里出现「你 + 实测次数」那种断言）。这些告警本来只有服务端控制台和
  `/api/stats` 能看见，而桌面版没有控制台——不端出来就等于没检查。
- 跑完校验发音档案的 AUTO 标记是否仍成对。标记坏掉的后果是统计静默停更，
  而那没有任何界面提示，所以这里要主动喊。
- 单飞锁 + 10 分钟超时 + 取消（按进程树杀）。日志流式展示，可取消。

## 安全

- 服务绑 `127.0.0.1`（见端口一节）。
- `/api/*` 的写请求加两道中间件：
  - `Origin` 必须缺席、或与 `Host` 同源、或主机名是环回。
    开发模式经 vite proxy，浏览器视角同源，不会误伤；局域网同机访问也仍成立。
    挡的是「某个网页在后台往 localhost 发请求」这一类。
  - 有体的写请求只接受 `application/json` 与 `application/octet-stream`
    （`POST /api/pronounce` 发的是后者）。`text/plain` 的简单请求没有预检，
    不拦就等于谁都能触发 AI 调用与代理写文件。
- 密钥：只存本机、只回打码、不进日志、不进备份、错误消息里脱敏。
- AI 回复按 markdown 渲染，沿用现有 react-markdown 配置，不启用原始 HTML。
- 代理模式在确认框里逐条说明权限边界（见上）。

## 界面文案随运行时分叉

新增 `GET /api/runtime`：`{ desktop, version, appRoot, userNotes }`。
凡是「在桌面版里是假话」的文案按它分叉，而不是各写一套：

- 设置页「怎么开启 / 怎么关闭」整段：浏览器模式讲双击启动器与关掉黑窗口，
  桌面版讲关窗口即退出、以及原生菜单里的「更换数据文件夹」。
- `AsrStatus` 里「看黑窗口」那条改成展开日志（两个模式同一份文案，不分叉）。
- `web/src/pages/SettingsPage.test.tsx` 那四条守卫现在假定只有一种文案
  （它直接读 `server/src/index.ts` 的源码比对 `STOP_HINT`）。
  分叉之后守卫要改成：服务源码里那句仍在、浏览器模式那份文案仍引它、
  桌面模式那份不许引它。守卫的**意图**是「引用别处界面的原话会烂」，不是「只许有一种文案」。

## 打包

`desktop/` 是新的 workspace（`electron`、`electron-builder`、`electron-updater`）。
实测 electron 包本身不含二进制、没有 install 脚本，所以把它放进 workspaces
不会让每个浏览器用户的 `npm install` 多下一份 Electron；
工具链其余部分是纯 JS 依赖。跑桌面版要 `npx install-electron` 取一次二进制。

- `desktop/package.json` 的 `author` 必须是对象 `{ "name": "…" }`，
  否则 exe 属性里的 CompanyName 会落回 Electron 二进制自带的「GitHub, Inc.」。
- `artifactName` 全 ASCII 且必须自带 `.${ext}`；安装版的名字写在 `nsis:` 块里
  （`-win-setup.exe`），免安装版是 `-win.zip`。三条理由 035 的 builder 配置里都有实测记录。
- 免安装那份用 zip，不用 portable：portable 每次双击都重解压整个应用。
- 图标直接用 `web/public/icon-512.png`（实测 512×512）复制成 `desktop/build/icon.png`，
  不新做资产；加一条守卫断言两份字节相同。
- `asarUnpack` 只放需要被操作系统直接读的文件（本仓没有 toast XML，
  但图标仍留在 asar 外，理由同 035）。
- `extraResources` 清单：`server/dist`、`web/dist`、`notes/`、`workflows/`、
  `asr-service/`（pyproject、uv.lock、.python-version、main.py）、
  `发音档案.template.md`、`scripts/vosk-models.json`、
  `runtime/node.exe`、`runtime/uv.exe` 与两份 LICENSE、
  以及服务的全部运行时依赖：`hono`、`@hono/node-server`、
  `better-sqlite3`（含 `build/Release/better_sqlite3.node`）、`bindings`、`file-uri-to-path`、
  `chokidar`、`cmu-pronouncing-dictionary`、`dayjs`、`dotenv`、`gray-matter`、`msedge-tts`、
  `cross-spawn` 及其运行时依赖。
- 清单不靠记性：一条守卫扫 `server/dist/**/*.js` 里的裸 specifier，
  逐个对 `extraResources`。这是 035 用两次「装出来点不开」换来的判据。
- 打包冒烟：在仓库外摆一份 `<resources>` 布局，用随包 `node.exe` 真起一次服务，
  探 `/api/health`、`/api/runtime`、`/api/asr/status`、`/api/ai/status`，
  并确认 better-sqlite3 在随包 Node 下真的能 `new Database()`。
- 真·只读安装目录（Program Files、非管理员）下的 uv 行为，冒烟清单里单列一条。
  临时目录里的只读实验已经过了，但那不等于安装目录。

## 发布与更新

- Windows x64：NSIS（可自动更新）+ zip（免安装，手动更新）。未签名，
  README 写清 SmartScreen 的「更多信息 → 仍要运行」。
- `electron-updater` 只在 NSIS 那条路点亮；自动检查默认关，开关状态落
  `<userData>/update-prefs.json`。原生菜单给「检查更新」与「重启以完成更新」。
- GitHub Actions：`validate`（版本对账 + `npm test`）→ `build`（`--publish never`，上传 Artifacts）
  → 单一 `publish` job（`gh release`）。tag 必须等于 `desktop/package.json` 的 version。
  版本号与 tag 由发版时单独确认，不在本设计里定死。
- 根目录加 `.desktop-policy.json`，记录平台、分发形态、更新策略、签名状态与偏离项。
  Electron / electron-builder / Actions 的版本窗口与发布卫生按 `desktop-app-standard` 执行，
  不在本仓手写死版本。
- 仓库里现有一个非版本 tag（`claude-code后端`），`v*` 触发不会撞上它。

## 测试

- **`vitest.config.ts` 的 include 是名单制**：`desktop/src/**/*.test.ts` 要显式加进 node 档，
  否则那些测试永远不会跑，而 `npm test` 照旧全绿。
  根 `typecheck` 加 `tsc -p desktop/tsconfig.typecheck.json`（直接调 tsc，不走 `-w`）。
- **`web/src/lib/nodeFloor.test.ts` 故意不加 `desktop/package.json`。**
  electron 的 `engines.node` 下限高于本仓 `engines.node` 的下限，
  加进去会顶穿浏览器模式那条路。测试里要写明这条例外的理由，
  否则下一个人会把它当漏掉的补上。
- 服务端单测：AI 设置的合并 / 打码 / 换主机清钥 / consent 闸、
  三套协议的地址归一与响应解析、错误映射与脱敏、CLI 参数表与输出解析、
  上下文组装、笔记草稿校验与写入、代理快照 / diff / 撤销 / 越界检测、
  ASR 状态机与进程树停止、数据锁（含残锁接管）。
- 桌面单测：路径解析、服务子进程（假 spawn）、首启向导的三条分支、
  更新偏好读写。主进程的 GUI 部分不进单测，进冒烟清单。
- 前端测试：设置页的服务商切换与密钥保持、讲解面板、笔记编辑器、
  对话页、代理页的日志与撤销、ASR 日志展开、运行时文案分叉。
  按中文找 antd 按钮先 `.replace(/\s/g, '')`（「评测」那颗会被自动插空格）。
- `uv lock --check` 进 CI。
- 跨仓拷贝（provider 目录、桌面身份字面量、STOP_HINT）一律用「对不上就红」的守卫，
  不靠人记得回来改。`brand.test.ts` 的 SKIP 要加 `desktop/release`、`desktop/vendor`。
- 桌面身份守卫：`APP_NAME` ↔ `desktop/package.json` 的 productName ↔
  builder 的 appId / productName / artifactName ↔ 主进程的 AUMID ↔
  README 与冒烟清单里的产物名。

## 文档改动

同一批改口，不留说谎窗口：

- `AGENTS.md`：`npm start` 的语义（现在只起服务）、边车由谁拉起、
  「关不掉识别服务」那条理由、文件布局表（加 `desktop/`、`workflows/`、`data/notes`）、
  「跟着发布走 / 本机数据 / 工具状态」三类划分、端口一节（30032 不再写死）、
  Node 版本一节（加随包 node.exe 与原生模块 ABI 的取舍）。
- `README.md`：桌面版下载与安装、SmartScreen、数据位置与首启向导、
  AI 设置（接口 / 命令行）、以及**局域网那一行**——
  绑定收到本机之后，「从局域网 IP 打开时麦克风不可用」这个降级档位不存在了，
  不能继续写成一个能用的模式。
- 设置页与 `AsrStatus` 的文案（见「界面文案随运行时分叉」）。
- `停止.cmd` / `停止.sh` / `停止.command` 的注释里提到 concurrently 与固定 30032 的部分。
- `.env.example`：`HOST`、`ASR_PORT`、`ASR_AUTOSTART`。
- `.gitignore`：`desktop/vendor/`（下载的 node.exe / uv.exe）、`desktop/release/`（打包产物）、
  `.ai-reference/`——浏览器模式下 `APP_ROOT` 就是仓库根，那份代理参考副本会落在仓库里，
  不忽略就是每次启动多一片未跟踪文件。`data/` 已整目录忽略，
  本机笔记、AI 设置、对话历史、代理快照都自动在内。

## 实施阶段

1. **桌面底座**：workspace、路径解析、随包 node/uv 的下载脚本、服务子进程、
   首启向导、数据锁、`SHIPPED_ROOT`/`APP_ROOT` 拆分、窗口与菜单、打包与冒烟守卫。
   这一阶段结束时桌面版能查词、放音、录音、评测、复习，功能与浏览器版一致。
2. **边车接管**：ASR 管理器、动态端口、状态与日志接口、进程树停止、
   `npm start` / `npm run dev` 语义调整、`AsrStatus` 改造。
3. **AI 底座**：provider 目录同步与消费层、AI 设置与 consent 闸、
   三套协议适配、CLI 调用表、状态与测试接口、安全中间件、笔记三根。
4. **讲解与笔记**：上下文组装、`/api/ai/explain`、词条页面板、
   笔记草稿与编辑器、`POST /api/notes`。
5. **助教对话**：历史存储、上下文检索、`/assistant` 页。
6. **代理整理**：`workflows/agent.md`、参考副本、运行与日志、快照 / diff / 撤销 / 越界告警。
7. **发布**：图标与身份守卫、builder 配置、更新、CI 与 release workflow、
   `.desktop-policy.json`、README / AGENTS / 冒烟清单。

每个阶段结束都要能跑：`npm test` 全绿 + 桌面版手工冒烟过一遍该阶段涉及的面。

## 实施计划的切分

这份设计覆盖两个能独立交付的子系统，**分成两份实施计划**，各自单独批准、
跑完一份再进下一份：

- **计划一 · 桌面化**：阶段 1、2，加上阶段 7 里的打包与发布骨架。
  结束时桌面版功能与浏览器版一致（查词、真人音、逐音素评测、复习、笔记、设置），
  边车由服务接管，能打出可安装的包。这一份里没有任何 AI 代码。
- **计划二 · AI**：阶段 3–6。它只依赖计划一落下的路径与安全底座，反向不依赖——
  所以计划一卡住时，AI 那部分照旧可以先在浏览器模式里做。

拆开的理由是验收面不同：计划一验的是「装出来的包在干净机器上跑得起来」，
计划二验的是「AI 的四种输出都对、且没有越界写」。合成一份的话，
任何一半红了都会挡住另一半的验收。版本号与 tag 留到计划二之后再定。

## 待实测（不靠推断）

- Electron 对 `media` 权限的默认行为。做法是显式设 handler 且冒烟清单里真录一次，
  不以「默认应该会放行」为依据。
- `gemini -o json`、`codex --output-last-message`、`agy` 的实际输出形状。
  实施时各跑一次；解析器一律有「回落到原始 stdout」这条兜底。
- 真·只读安装目录下的 uv 与 Python 环境创建。
- 数据锁与现有测试的相互作用（有没有用例在同一目录开两次服务）。
- 首启向导选旧文件夹时，旧 `notes/` 与新版随附笔记的同名冲突实际有多少
  （决定「本机优先」这条要不要在界面上提示得更醒目）。
