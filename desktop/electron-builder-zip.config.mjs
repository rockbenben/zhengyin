// zip 免安装版：独立输出目录，不产 latest.yml（更新元数据只能有 NSIS 那条）。
import base from './electron-builder.config.mjs';

export default {
  ...base,
  directories: { ...base.directories, output: 'desktop/release-zip' },
  extraMetadata: { ...base.extraMetadata, zhengyinChannel: 'zip' },
  publish: null,
  win: { ...base.win, target: [{ target: 'zip' }] },
  nsis: undefined,
};
