import { describe, expect, test } from 'bun:test'
import type { WorkspaceGitStatus } from '@poietica/feature-conversation/ui-api'
import type { SessionGoal } from '../../../shared/model/goal'
import type { TodoItem } from '../../../shared/timeline/timeline-contract'
import { statusSummaryOf } from '../status-summary'

const git = (added: number, removed: number): WorkspaceGitStatus => ({
  added,
  ahead: 0,
  behind: 0,
  branch: 'main',
  branches: ['main'],
  busy: false,
  detachedAt: null,
  dirtyFileCount: 0,
  onRefresh: () => undefined,
  removed,
  upstream: null,
})

const goal = (status: SessionGoal['status']): SessionGoal => ({
  completionCriterion: null,
  objective: '把状态面板对齐 ZCode',
  receivedAt: 0,
  status,
  tokensUsed: 0,
  turnsUsed: 0,
  wallClockMs: 0,
})

const todo = (title: string, status: TodoItem['status']): TodoItem => ({ status, title })

function summaryOf(input: {
  goal?: SessionGoal | undefined
  git?: WorkspaceGitStatus | undefined
  runningAgents?: number
  runningTasks?: number
  todos?: readonly TodoItem[]
}) {
  return statusSummaryOf({
    goal: input.goal,
    git: input.git,
    runningAgents: input.runningAgents ?? 0,
    runningTasks: input.runningTasks ?? 0,
    todos: input.todos ?? [],
  })
}

describe('收起态摘要', () => {
  test('没有内容（含干净仓库）→ null，整块面板不挂载', () => {
    expect(summaryOf({})).toBeNull()
    expect(summaryOf({ git: git(0, 0) })).toBeNull()
  })

  test('优先级：当前待办 → 目标 → Git → 已完成待办 → 待办进度 → 在跑资源', () => {
    const todos = [todo('已完成的事', 'done'), todo('正在做的事', 'in_progress')]

    expect(summaryOf({ git: git(12, 4), goal: goal('active'), todos })).toEqual({
      kind: 'todo-current',
      title: '正在做的事',
    })
    expect(summaryOf({ git: git(12, 4), goal: goal('active') })).toEqual({
      kind: 'goal',
      title: '把状态面板对齐 ZCode',
    })
    expect(summaryOf({ git: git(12, 4) })).toEqual({ added: 12, kind: 'git', removed: 4 })
    expect(summaryOf({ todos: [todo('已完成的事', 'done')] })).toEqual({
      kind: 'todo-completed',
      title: '已完成的事',
    })
    expect(summaryOf({ todos: [todo('待处理的事', 'pending')] })).toEqual({
      done: 0,
      kind: 'todo-progress',
      total: 1,
    })
    expect(summaryOf({ runningAgents: 2, runningTasks: 1 })).toEqual({
      agents: 2,
      count: 3,
      kind: 'running',
      tasks: 1,
    })
  })

  test('已完成的目标不撑起摘要', () => {
    expect(summaryOf({ goal: goal('complete') })).toBeNull()
  })
})
