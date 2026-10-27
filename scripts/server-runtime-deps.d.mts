// 打包闭包脚本是 .mjs，不进 TypeScript 构建；这里只给测试和打包配置用的形状。
export declare function serverRuntimeDeps(root: string): string[];
export declare function serverRuntimeResources(root: string): Array<{ from: string; to: string }>;
