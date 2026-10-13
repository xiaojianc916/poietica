export const GOAL_CONTROL_ID = 'goal'
export const GOAL_ENABLED = 'on'
export const GOAL_DISABLED = 'off'
export const GOAL_PAUSED = 'pause'
export const GOAL_RESUMED = 'resume'

/** 暂停 / 继续 / 改正文各走自己的 RPC，不借输入框选择器那条只认 on / off 的出口（审查 R-10）。 */
export type GoalAction =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'clear' }

export type GoalActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** **永不 reject**：失败折成 `{ ok: false, error }`。 */
export type GoalActionHandler = (action: GoalAction) => Promise<GoalActionResult>
