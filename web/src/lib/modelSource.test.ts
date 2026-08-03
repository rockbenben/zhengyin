import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 模型从哪儿取（`asr-service/main.py` 的 `resolve_model`）。
 *
 * ── 为什么这几条只读源码 ──
 *
 * 那段逻辑在 Python 里，而 `npm test` **不能**依赖 Python：这个仓库明确支持
 * 没装 uv 也照常跑（查词、真人音、录音、A/B、复习全都在），把 uv 变成跑测试的
 * 前提等于把那条承诺推翻。所以这里只守几条读源码就能守住的底线，
 * 真正的行为是实测验的（四条分支都跑过：本地缓存命中不重下、ModelScope 真下、
 * 真实失败返回 None 而不是抛出、钉死某个源时的两种行为）。
 *
 * ── 为什么值得加 modelscope 这个依赖 ──
 *
 * 同一个模型，实测四轮吞吐：
 *   modelscope      15 / 59 / 57 / 56 MB/s
 *   huggingface.co  1.35 / 0.75 / 0.69 / 0.73
 *   hf-mirror       3.06 / 1.74 / 1.26 / 0.09
 * 整包 1205 MB 实下：ModelScope 37.5s（32 MB/s）。按官方那个速度是二十多分钟。
 * 使用者全是中文母语者，这是"装得上"和"装不上"的差别。代价 5 个包（45→50）。
 *
 * ModelScope **不能**靠 HF_ENDPOINT 接管：curl 打 /resolve/ 和 /api/models/ 都是 200，
 * 但 huggingface_hub 实际 LocalEntryNotFoundError（对照过官方和 hf-mirror 都 OK）。
 * 所以只能走它自己的 SDK。
 */
const root = join(import.meta.dirname, '..', '..', '..');
const py = readFileSync(join(root, 'asr-service', 'main.py'), 'utf8');

describe('模型来源的几条底线', () => {
  it('**先看本地缓存**——已经下过 1.2GB 的人升上来不该重下一遍', () => {
    const cache = py.indexOf('_hf_cache_hit()');
    const ms = py.indexOf('_from_modelscope() or MODEL');
    expect(cache, '找不到缓存检查').toBeGreaterThan(0);
    expect(ms, '找不到默认分支').toBeGreaterThan(0);
    expect(cache, '缓存检查排到了 ModelScope 后面，会导致重复下载').toBeLessThan(ms);
  });

  /**
   * 说了「不重新下载」，就必须在任何取模型的路径之前**返回**。
   *
   * 原来这两件事是分开的：先无条件打那句日志，再判断要不要 return。于是
   * `MODEL_SOURCE=modelscope` 且本地 HF 缓存命中时——打完「不重新下载」照样落进
   * ModelScope 那条路，而 ModelScope 有自己的缓存目录，那边没有的话这一趟真的会
   * 再下 1.2GB。钉死这个源的人一边看着「不重新下载」，一边看着进度条跑。
   *
   * 行为本身没错（钉死了就该照办，`.env` 里那句是承诺）；错的是那句话。
   *
   * **这条只能查形状，查不了控制流。** 第一版写的是「这句日志和后面第一个
   * `_from_modelscope(` 之间要有 `return MODEL`」——那条断言在出 bug 的旧代码上照样绿，
   * 因为旧代码里那个 return 确实在，只是**有条件**。所以这里改成查「紧跟」：
   * 打完这句话，下一条语句就必须是 return，中间不许有任何判断。
   * 代价是往这两行中间插一句注释也会红——那时把注释挪到日志上面即可，
   * 而它不会像上一版那样悄悄放过真正的回归。
   */
  it('「不重新下载」这句日志后面必须紧跟 return', () => {
    expect(
      py,
      '这句日志和 return 之间夹了判断——那就意味着它可能打完照样去取模型',
    ).toMatch(/不重新下载"\)\s*\n\s*return MODEL\b/);
  });

  it('ModelScope 不通要回落 HuggingFace，不能把启动拖死', () => {
    expect(py).toMatch(/_from_modelscope\(\) or MODEL/);
    // 取模型那段必须自己吞掉异常，返回 None 交给上层换路
    expect(py).toMatch(/def _from_modelscope[\s\S]{0,600}?except Exception[\s\S]{0,200}?return None/);
  });

  it('钉死了某个源就别偷偷换——MODEL_SOURCE=modelscope 取不到要明确报错', () => {
    expect(py).toMatch(/MODEL_SOURCE == "modelscope"[\s\S]{0,300}?raise RuntimeError/);
  });

  it('MODEL_SOURCE 从环境读——它要能被 .env 管到（靠 scripts/asr.mjs 那层包装）', () => {
    expect(py).toMatch(/MODEL_SOURCE\s*=\s*os\.environ\.get\("MODEL_SOURCE"/);
    const wrapper = readFileSync(join(root, 'scripts', 'asr.mjs'), 'utf8');
    expect(wrapper, '包装不合并 .env 的话 MODEL_SOURCE 传不进去').toMatch(/parseEnv/);
  });

  it('modelscope 写进了依赖，不然 import 会失败', () => {
    const toml = readFileSync(join(root, 'asr-service', 'pyproject.toml'), 'utf8');
    expect(toml).toMatch(/modelscope/);
  });

  it('日志要说得出模型是从哪来的——启动窗口是唯一能看见下载进度的地方', () => {
    // 光 getLogger 不配 handler 的话，uvicorn 下一行都打不出来（原来就是这样）
    expect(py, '没配 handler，日志根本不会出现').toMatch(/logging\.basicConfig/);
    expect(py).toMatch(/来源/);
  });
});
