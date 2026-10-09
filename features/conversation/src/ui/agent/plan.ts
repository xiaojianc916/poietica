import type { InteractionAnswer } from '@poietica/engine'

/**
 * 计划卡片的一档答复（04 页 §3.12 第 5 支）。
 *
 * 卡片上的三颗按钮对应 `decision` 三档；`feedback` 只有「修改…」才带。答复类型就取
 * 引擎契约那一支，不另立一份词表 —— 两处各写一份，改一处必然漏一处。
 */
export type PlanAnswer = Extract<InteractionAnswer, { kind: 'plan' }>
export type PlanDecision = PlanAnswer['decision']
