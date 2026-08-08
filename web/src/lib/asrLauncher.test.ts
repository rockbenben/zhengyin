import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error 纯 JS 的启动脚本，没有类型声明；这里只测它的两块纯逻辑
import { parseEnv, LOOKS_LIKE_NETWORK_FAILURE, downloadHelp } from '../../../scripts/asr.mjs';

/**
 * 边车启动包装（`scripts/asr.mjs`）。
 *
 * ── 为什么会有这个包装 ──
 *
 * `.env` 是这个应用的配置通道，可**边车读不到它**：`dotenv/config` 只在 server
 * 那个进程里 import，而边车是 concurrently 拉起的**兄弟进程**。实测过跑着的那个
 * python 进程的启动命令，里头没有任何东西注入 .env。
 *
 * 后果：模型 1.2GB，从 HuggingFace 下；想换源（HF_ENDPOINT）只能开终端设环境变量，
 * 而「双击启动」这套方式存在的全部意义就是让人不必开终端。
 *
 * 默认**没有**换成镜像：按 Range 实测三轮，官方 2.11/0.74/2.58 MB/s、
 * 镜像 0.25/2.34/0.19 MB/s，波动远大于差距。所以给的是开关，不是新默认。
 */
const root = join(import.meta.dirname, '..', '..', '..');

describe('.env 要能管到边车', () => {
  it('读得出最朴素的 KEY=VALUE', () => {
    expect(parseEnv('HF_ENDPOINT=https://hf-mirror.com')).toEqual({
      HF_ENDPOINT: 'https://hf-mirror.com',
    });
  });

  it('注释、空行、值两边的引号都处理掉', () => {
    const got = parseEnv([
      '# 换个模型源',
      '',
      "  HF_ENDPOINT = 'https://hf-mirror.com' ",
      'PORT="30041"',
    ].join('\n'));
    expect(got).toEqual({ HF_ENDPOINT: 'https://hf-mirror.com', PORT: '30041' });
  });

  it('已经在环境里的不覆盖——显式设的要赢过文件', () => {
    const got = parseEnv('HF_ENDPOINT=https://from-file', { HF_ENDPOINT: 'https://from-shell' });
    expect(got.HF_ENDPOINT).toBeUndefined();
  });

  it('值里带 = 不会被截断（token 之类常有）', () => {
    expect(parseEnv('K=a=b=c').K).toBe('a=b=c');
  });

  /**
   * stdout 是管道时 Python 按**系统区域编码**写（中文 Windows 上是 GBK），
   * Node 这头一律按 UTF-8 读，于是边车那几句中文在窗口里全成了「锟斤拷」——
   * 而「模型不在本地缓存里，开始获取」正是首次启动最该看清的一句。
   * 这一条不是配置，是这条管道的事实，所以钉死、不给 .env 覆盖。
   */
  it('钉死 PYTHONIOENCODING——不然边车的中文在窗口里是乱码', () => {
    const wrapper = readFileSync(join(root, 'scripts', 'asr.mjs'), 'utf8');
    expect(wrapper).toMatch(/PYTHONIOENCODING:\s*'utf-8'/);
    // 必须排在 fromFile 后面：写反了就能被 .env 里一行 PYTHONIOENCODING 顶掉
    expect(wrapper).toMatch(/\.\.\.fromFile,\s*\n?\s*PYTHONIOENCODING/);
  });

  /**
   * transformers 在权重是 .bin、仓库里没有 safetensors 时会起一个后台线程，
   * 去 hub 上翻转换 PR、翻不着就请 bot 开一个（`modeling_utils.py` 的
   * `Thread-auto_conversion`，抓栈确认过）。它跑完在**加载之后**，于是那两行
   * 「You are sending unauthenticated requests to the HF Hub」正好压在窗口最后一行。
   * 对本机零收益——模型已经从 .bin 加载好了，那个 PR 是开给公共仓库的。
   */
  it('关掉 safetensors 转换那个后台线程——它只往窗口最后甩两行英文告警', () => {
    const wrapper = readFileSync(join(root, 'scripts', 'asr.mjs'), 'utf8');
    expect(wrapper).toMatch(/DISABLE_SAFETENSORS_CONVERSION:\s*'1'/);
  });

  it('npm run asr 真的走这个包装，不是直接调 uv', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts.asr, '绕过包装的话 .env 又管不到边车了').toContain('scripts/asr.mjs');
  });
});

describe('模型下不下来时，终端里要有一句能照做的话', () => {
  it('认得出连接类失败', () => {
    for (const line of [
      "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='huggingface.co', port=443)",
      'urllib3.exceptions.MaxRetryError: HTTPSConnectionPool(host=\'huggingface.co\')',
      'socket.timeout: The read operation timed out\nRead timed out.',
      'requests.exceptions.SSLError: EOF occurred in violation of protocol',
      'OSError: [Errno -3] Temporary failure in name resolution',
    ]) {
      expect(LOOKS_LIKE_NETWORK_FAILURE.test(line), `没认出来：${line.slice(0, 40)}`).toBe(true);
    }
  });

  /**
   * **误报比漏报糟得多**：正常启动时 HF 本来就会打一句 unauthenticated 的警告，
   * 还有一路 Loading weights 的进度条。要是这些也算"下不下来"，
   * 每次启动都弹一屏假警报，那比什么都不提示更坏。
   */
  it('正常启动的那几行不许误报', () => {
    for (const line of [
      'Warning: You are sending unauthenticated requests to the HF Hub. Please set a HF_TOKEN to enable higher rate limits and faster downloads.',
      'Loading weights:   0%|          | 0/424 [00:00<?, ?it/s]Loading weights: 100%|██████████| 424/424',
      'INFO:     Application startup complete.',
      'INFO:     Uvicorn running on http://127.0.0.1:30032 (Press CTRL+C to quit)',
      'INFO:     127.0.0.1:2668 - "GET /health HTTP/1.1" 200 OK',
    ]) {
      expect(LOOKS_LIKE_NETWORK_FAILURE.test(line), `误报了：${line.slice(0, 40)}`).toBe(false);
    }
  });

  it('那段话要说清「别的功能不受影响」和「怎么换源」', () => {
    const s = downloadHelp(undefined);
    expect(s).toMatch(/不受影响|照常/);
    expect(s).toContain('HF_ENDPOINT');
    expect(s).toContain('.env');
    // 不许把镜像说成"更快"——实测两边都不稳
    expect(s).not.toMatch(/镜像更快|更快的源/);
  });

  it('说得出这次用的是哪个源——不然不知道该换什么', () => {
    expect(downloadHelp('https://hf-mirror.com')).toContain('https://hf-mirror.com');
    expect(downloadHelp(undefined)).toContain('huggingface.co');
  });
});
