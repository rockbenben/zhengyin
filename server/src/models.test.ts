import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, modelFile, modelState, resolveModel } from './models.js';

const reg = loadRegistry(process.cwd());

describe('模型清单', () => {
  it('真实清单里 default 指向一个确实存在的模型', () => {
    // 这条防的是清单被手改成 default: "medium" 而 models 里没有 medium——
    // resolveModel 会静默退到 models[0]，用户拿到的跟清单声明的不是一个模型。
    expect(reg.models.map((m) => m.id)).toContain(reg.default);
  });

  it('id 不重复', () => {
    const ids = reg.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * label 里那个兆数必须跟 sizeMb 是同一个数。
   *
   * 这两样**都会显示给用户，而且在同一屏上**：设置页的选项写 label（「大模型 · 125MB」），
   * 没下载时紧挨着又写 `{sizeMb}MB，只需一次`。改了一个忘了另一个，那一屏就自相矛盾。
   *
   * 清单文件自己的 _comment 写着「不各写一份——这个项目被『两处编码同一份知识然后
   * 悄悄漂移』坑过好几次」，而它自己就把这个数写了两遍。消灭不掉（label 还带着
   * 「大模型 / 小模型」这个只此一处的叫法），那就让它对不上时会红。
   */
  it('label 里的兆数跟 sizeMb 一致', () => {
    for (const m of reg.models) {
      const n = /(\d+)\s*MB/i.exec(m.label)?.[1];
      expect(n, `「${m.label}」里读不出兆数，没法跟 sizeMb 对账`).toBeTruthy();
      expect(Number(n), `${m.id}：label 写 ${n}MB，sizeMb 是 ${m.sizeMb}`).toBe(m.sizeMb);
    }
  });

  it('打包文件名跟 /api/model/:file 的白名单正则相容', () => {
    // app.ts 用 /^[\w.-]+\.tar\.gz$/ 挡路径穿越。清单里加个带空格或斜杠的 name，
    // 下载脚本能打出来、托管接口却会 400，听辨直接报"模型没装"。
    for (const m of reg.models) expect(modelFile(m)).toMatch(/^[\w.-]+\.tar\.gz$/);
  });
});

describe('resolveModel', () => {
  it('认识的 id 原样返回', () => {
    expect(resolveModel(reg, 'small').id).toBe('small');
  });

  it('未设置 / 不认识的 id 退回 default（而不是 models[0]）', () => {
    // 用一份 default 故意不是第一项的清单，才能区分"退回 default"和"退回第一项"。
    const fake = { default: 'b', models: [
      { id: 'a', name: 'n-a', sizeMb: 1, label: 'A', note: '' },
      { id: 'b', name: 'n-b', sizeMb: 2, label: 'B', note: '' },
    ] };
    expect(resolveModel(fake, undefined).id).toBe('b');
    expect(resolveModel(fake, 'nope').id).toBe('b');
  });
});

describe('modelState', () => {
  it('downloaded 反映的是 tar.gz 在不在，不是目录在不在', () => {
    // 下载脚本中途失败时，data/models/ 下会留着解压出来的**目录**但没有 tar.gz。
    // 若按目录判断，设置页会说"已下载"而听辨报模型缺失——两处说法打架。
    const dir = mkdtempSync(join(tmpdir(), 'models-'));
    const small = reg.models.find((m) => m.id === 'small')!;
    writeFileSync(join(dir, modelFile(small)), 'x');

    const st = modelState(reg, 'small', dir);
    expect(st.selected).toBe('small');
    expect(st.file).toBe(modelFile(small));
    expect(st.options.find((o) => o.id === 'small')!.downloaded).toBe(true);
    // 另一个没写文件，必须是 false
    for (const o of st.options) {
      if (o.id !== 'small') expect(o.downloaded).toBe(false);
    }
  });

  it('列出清单里全部模型，不只列选中的那个', () => {
    const st = modelState(reg, 'large', mkdtempSync(join(tmpdir(), 'models-')));
    expect(st.options.map((o) => o.id).sort()).toEqual(reg.models.map((m) => m.id).sort());
  });
});
