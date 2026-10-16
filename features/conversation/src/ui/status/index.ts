/*
 * status 区：目标、任务面板与入口提示。区与区之间只能经本文件互相引用。
 */

export type { GoalActionHandler } from '../shared/model/goal-control'
export { EntryNotices } from './entry-notices'
export { type GoalActions, GoalBar, useGoalActions } from './goal/goal-bar'
export { CONVERSATION_TODO_LAYOUT_STYLE, ConversationTodoPopover } from './todo/conversation-todo-popover'
