import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 命令行调用（连接测试、讲解、笔记草稿、助教对话）的工作目录：**一个空的专用目录**。
 *
 * **为什么不能沿用服务进程所在的目录**：那些命令行工具会把自己所在目录当成工作区，
 * 把里面的规则文件当上下文读进去。实测 agy 会把
 * `<仓库>\AGENTS.md`（78 KB，截到 24 KB）塞进「讲解发音」这个跟项目规则毫无关系的
 * 请求里——既慢（每次多一秒多），又把不相干的规则喂给了模型。
 *
 * 这里的上下文本来就是**拼进提示词**的（发音档案、相关笔记、这次的错误），
 * 不需要读文件，所以给它们一个空目录最干净。
 *
 * **命令行整理不用这个**：它在单次运行的工作副本中编辑，通过校验后才提交到本机数据（见 agent.ts）。
 */
export function cliWorkspace(dataDir: string): string {
  const dir = join(dataDir, 'ai-workspace');
  mkdirSync(dir, { recursive: true });
  return dir;
}
