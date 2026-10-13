import type { Controls } from '@poietica/engine'
import { assertNever, isAppError } from '@poietica/foundation'
import type { GoalAction, GoalActionResult } from './components/goal/goal-control'
import { describeFailure } from './failure'

export interface GoalActionApi {
  setGoal(threadId: string, goal: string | null): Promise<Controls>
  pauseGoal(threadId: string): Promise<Controls>
  resumeGoal(threadId: string): Promise<Controls>
}

/*
 * 把面板上的一个目标动作下到 Core（R-10）。
 *
 * - **永不 reject**：失败折成 `{ ok: false, error }`，面板据此亮那条 role=alert。
 * - **不在这里改控件表**：成功之后引擎会推 controls.changed，stores.controls 由那条通知更新 —— 同一个事实只有一条写入路径。
 */
export async function runGoalAction(
  api: GoalActionApi,
  threadId: string,
  action: GoalAction,
): Promise<GoalActionResult> {
  try {
    switch (action.kind) {
      case 'pause':
        await api.pauseGoal(threadId)
        break
      case 'resume':
        await api.resumeGoal(threadId)
        break
      case 'edit':
        await api.setGoal(threadId, action.objective)
        break
      case 'clear':
        await api.setGoal(threadId, null)
        break
      default:
        return assertNever(action)
    }
    return { ok: true }
  } catch (cause) {
    return { ok: false, error: isAppError(cause) ? cause.message : describeFailure(cause) }
  }
}
