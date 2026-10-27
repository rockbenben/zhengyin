/**
 * 主进程与打包配置共用的身份字面量。
 *
 * builder 配置是纯 JS、跑在 electron-builder 自己的 Node 里，不经过 tsc，
 * 所以那边只能再写一份字面量；web/src/lib/desktopIdentity.test.ts 把两边钉在一起。
 */
export const APP_ID = 'com.rockbenben.zhengyin';
export const PRODUCT_NAME = '正音';
