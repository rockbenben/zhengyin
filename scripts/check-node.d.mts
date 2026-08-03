// 这个脚本要在**老 Node** 上跑得起来（它存在的全部理由就是拦老 Node），
// 所以源码是 .mjs、不进构建；类型单独给一份，好让 nodeFloor.test.ts 能 import 它，
// 而不是在测试里另抄一份版本比较。
export declare function meetsFloor(version: string, range: string | undefined): boolean;
export declare function floorOf(range: string | undefined): string | null;
