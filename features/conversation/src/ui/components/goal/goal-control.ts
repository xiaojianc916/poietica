export const GOAL_CONTROL_ID = 'goal'
export const GOAL_ENABLED = 'on'
export const GOAL_DISABLED = 'off'
export const GOAL_PAUSED = 'pause'
export const GOAL_RESUMED = 'resume'

/**
 * 目标面板上能做的四件事（审查 R-10）。它们不是「控件取值」：暂停 / 继续 / 改正文各有一条
 * 自己的 RPC（controls.pauseGoal / resumeGoal / setGoal），不再借输入框选择器那条只认
 * on / off 的出口。
 */
export type GoalAction =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'clear' }

/** 一个目标动作的结局：失败带一句给人看的话（面板上那条 role=alert）。 */
export type GoalActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** 目标动作的出口：**永不 reject**，失败折成 `{ ok: false, error }`。 */
export type GoalActionHandler = (action: GoalAction) => Promise<GoalActionResult>
