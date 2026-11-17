import { requestStops } from '../server/src/stopControl.ts';

try {
  const result = await requestStops();
  if (result.pending > 0) {
    console.error('正音还在运行或未响应。请到启动窗口按 Ctrl+C。');
    process.exitCode = 1;
  } else {
    process.exitCode = result.requested > 0 ? 0 : 2;
  }
} catch (error) {
  console.error(`无法停止正音：${error.message}`);
  process.exitCode = 1;
}
