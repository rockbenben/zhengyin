import type { AiSettings } from '../types';

/**
 * 没保存的 AI 设置草稿，**跨卸载保留**。
 *
 * 设置页按五组切换（应用 / 声音 / AI 讲解 / 主题 / 搬家），切走再切回来会
 * **重新挂载**「AI 讲解」那一张卡——而草稿本来只活在组件的 `useState` 里，
 * 于是刚输入的密钥、刚勾的同意会跟着卸载一起消失，用户得从头再打一遍。
 *
 * 草稿放在模块级：重新挂载时接着用，**真正保存过**才清掉。
 *
 * **它只是草稿**：服务端那份才是真的。所以「保存」成功时必须 `clearAiDraft()`，
 * 否则下次进来会拿一份已经存过的旧草稿当用户刚改的东西。
 */
let draft: AiSettings | null = null;

/** 取草稿。没有就是 null。 */
export const getAiDraft = (): AiSettings | null => draft;

/** 记下草稿。 */
export const setAiDraft = (s: AiSettings): void => { draft = s; };

/** 清掉草稿。保存成功之后要调。 */
export const clearAiDraft = (): void => { draft = null; };
