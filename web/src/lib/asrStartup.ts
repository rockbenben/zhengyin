import type { AsrStatusInfo } from '../types';

export function asrStartupLabel({ stage, stalled }: Pick<AsrStatusInfo, 'stage' | 'stalled'>): string {
  if (stage === 'dependencies') return stalled ? '依赖安装暂时没有进展' : '正在安装依赖';
  if (stage === 'model') return stalled ? '模型加载暂时没有进展' : '正在加载模型';
  return stalled ? '识别服务启动暂时没有进展' : '正在启动识别服务';
}

export function asrStartupPollMs({ stage, stalled }: Pick<AsrStatusInfo, 'stage' | 'stalled'>): number {
  return stage === 'model' && !stalled ? 500 : 2000;
}
