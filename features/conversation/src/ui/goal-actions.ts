import type { Controls } from '@poietica/engine'
import { assertNever, isAppError } from '@poietica/foundation'
import type { GoalAction, GoalActionResult } from './components/goal/goal-control'
import { describeFailure } from './failure'

/** 目标动作要用到的三条 RPC（createConversationApi 的子集；测试可塞替身）。 */
export interface GoalActionApi {
  setGoal(threadId: string, goal: string | null): Promise<Controls>
  pauseGoal(threadId: string): Promise<Controls>
  resumeGoal(threadId: string): Promise<Controls>
}

/**
 * 把面板上的一个目标动作下到 Core（审查 R-10）。
 *
 * - **永不 reject**：失败折成 `{ ok: false, error }`，面板据此亮那条 role=alert；
 *   RPC 交回的 AppError（Core 抛的、断线 / 超时也是）原样用它的 message ——「这条对话没有进行中的目标」
 *   这类话本来就是写给人看的；其余意外走 describeFailure，原样不改写。
 * - **不在这里改控件表**：成功之后引擎会推 controls.changed（OmpSession.changeGoal 收尾必报一次），
 *   stores.controls 由那条通知更新 —— 同一个事实只有一条写入路径，返回值里的 Controls 在这里不用。
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
