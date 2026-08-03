import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 模型清单从 scripts/vosk-models.json 读，跟 scripts/fetch-model.mjs 共用同一份——
// 那个脚本是 .mjs、这里是 .ts，没法互相 import，但**数据**必须只有一处。这个项目已经
// 被"两处编码同一份知识然后悄悄漂移"坑过好几次（ASCII g vs IPA ɡ 就是三次）。
export interface VoskModel {
  id: string;
  name: string;
  sizeMb: number;
  label: string;
  note: string;
}

interface Registry {
  default: string;
  models: VoskModel[];
}

let cache: Registry | null = null;

export function loadRegistry(root: string): Registry {
  if (!cache) {
    const raw = readFileSync(join(root, 'scripts', 'vosk-models.json'), 'utf8');
    const parsed = JSON.parse(raw) as Registry;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
      throw new Error('scripts/vosk-models.json 里没有任何模型');
    }
    cache = parsed;
  }
  return cache;
}

/** tar.gz 文件名——vosk-browser 要的是 gzip tar，不是官方发布的 zip */
export function modelFile(m: VoskModel): string {
  return `${m.name}.tar.gz`;
}

export function resolveModel(reg: Registry, id: string | undefined): VoskModel {
  return reg.models.find((m) => m.id === id)
    ?? reg.models.find((m) => m.id === reg.default)
    ?? reg.models[0];
}

/** 给设置页用的完整状态：选了哪个、下载了没有、都有哪些可选 */
export function modelState(reg: Registry, selectedId: string | undefined, modelsDir: string) {
  const selected = resolveModel(reg, selectedId);
  return {
    selected: selected.id,
    file: modelFile(selected),
    options: reg.models.map((m) => ({
      id: m.id,
      label: m.label,
      sizeMb: m.sizeMb,
      note: m.note,
      // 判断"下载了没有"只看最终 tar.gz 在不在，跟 GET /api/model/:file 的判据一致，
      // 免得设置页说"已下载"而评测却报模型缺失。
      downloaded: existsSync(join(modelsDir, modelFile(m))),
    })),
  };
}
