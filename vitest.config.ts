import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 两套环境：node 跑服务端和纯函数，dom 跑组件渲染。
//
// dom 那一档是为了拦「接线没接上」——字段在、类型在、注释在，就是没进 JSX。
// 这个项目栽过两次（comparedWith 从没渲染过；referenceUrl 为 null 时按钮默默变灰），
// 两次都从类型检查底下溜了过去，而纯函数测试对这类问题天生无效。
// 所以组件测试只测一件事：**某个字段的取值必须改变用户看到的东西**。
// 不测样式布局、不追覆盖率——改版就会大面积假红。

/**
 * 单个用例的超时。**必须写在每个 project 里面**：有 `projects:` 时，
 * 顶层 `test.testTimeout` 不会往下传，写了也还是默认的 5000ms。
 *
 * 抬上来是因为全量跑会偶发假红——机器上同时还跑着这个应用本身（server + 占
 * 1.2GB 模型的边车），几条重的用例正好压在 5 秒线上。真卡死照样红，只是晚十秒。
 */
const TIMEOUT = 15_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['server/src/**/*.test.ts', 'web/src/lib/**/*.test.ts'],
          environment: 'node',
          testTimeout: TIMEOUT,
        },
      },
      {
        // .tsx 要过 JSX 转换，所以这一套挂 react 插件
        plugins: [react()],
        test: {
          name: 'dom',
          include: ['web/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./web/src/test-setup.ts'],
          testTimeout: TIMEOUT,
        },
      },
    ],
  },
});
