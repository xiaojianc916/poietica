import type { WorkspaceGitStatus } from '../../../ui-api'
import type { SessionGoal } from '../../shared/model/goal'
import type { TodoItem } from '../../shared/timeline/timeline-contract'

/*
 * 收起态只报一项主状态，优先级照 ZCode 的摘要链：当前待办 → 目标 → Git 变更 → 已完成待办 →
 * 待办进度 → 在跑资源。返回 null 即整块状态面板不挂载 —— 没有内容时不画只有一圈边框的空壳，
 * 也不预留展开卡的横向让位。
 *
 * Git 只在工作区真的增删了行时才算内容：干净仓库不该因为「是个 Git 仓库」就挂出面板。
 * 已完成的目标不进来（目标栏在 complete 时已经撤下，面板不另立一个只报旧目标的入口）。
 */
export type StatusSummary =
  | { readonly kind: 'todo-current'; readonly title: string }
  | { readonly kind: 'goal'; readonly title: string }
  | { readonly kind: 'git'; readonly added: number; readonly removed: number }
  | { readonly kind: 'todo-completed'; readonly title: string }
  | { readonly kind: 'todo-progress'; readonly done: number; readonly total: number }
  | { readonly kind: 'running'; readonly count: number; readonly agents: number; readonly tasks: number }

export function statusSummaryOf(input: {
  readonly goal: SessionGoal | undefined
  readonly git: WorkspaceGitStatus | undefined
  readonly runningAgents: number
  readonly runningTasks: number
  readonly todos: readonly TodoItem[]
}): StatusSummary | null {
  const current = input.todos.find((item) => item.status === 'in_progress')
  if (current !== undefined) {
    return { kind: 'todo-current', title: current.title }
  }

  if (input.goal !== undefined && input.goal.status !== 'complete') {
    return { kind: 'goal', title: input.goal.objective }
  }

  if (input.git !== undefined && input.git.added + input.git.removed > 0) {
    return { kind: 'git', added: input.git.added, removed: input.git.removed }
  }

  const done = input.todos.filter((item) => item.status === 'done')
  const lastDone = done.at(-1)
  if (lastDone !== undefined) {
    return { kind: 'todo-completed', title: lastDone.title }
  }

  if (input.todos.length > 0) {
    return { kind: 'todo-progress', done: done.length, total: input.todos.length }
  }

  const count = input.runningAgents + input.runningTasks
  if (count > 0) {
    return { kind: 'running', count, agents: input.runningAgents, tasks: input.runningTasks }
  }

  return null
}
