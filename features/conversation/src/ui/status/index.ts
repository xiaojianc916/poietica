/*
 * status 区：目标、状态面板与入口提示。区与区之间只能经本文件互相引用。
 */

export type { GoalActionHandler } from '../shared/model/goal-control'
export {
  CONVERSATION_STATUS_PANEL_LAYOUT_STYLE,
  ConversationStatusPanel,
  type SummaryPanelPreference,
  type SummaryPanelVariant,
} from './conversation-status-panel'
export { EntryNotices } from './entry-notices'
export { runGoalAction } from './goal/goal-actions'
export { type GoalActions, GoalBar, useGoalActions } from './goal/goal-bar'
