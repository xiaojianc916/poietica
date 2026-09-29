import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionGoal } from '../agent/goal'
import type { WorkspaceGitStatus } from '../surface/goal/workspace-git-status'
import {
  backgroundTaskProgressLabel,
  formatDuration,
  formatElapsed,
  TaskPanelContent,
  todoFocusWindow,
} from '../surface/todo/todo-panel'
import type { BackgroundTaskItem, TodoItem } from '../timeline/timeline-contract'

const todos: readonly TodoItem[] = [
  { title: '搭骨架', status: 'done' },
  { title: '写组件', status: 'in_progress' },
  { title: '补测试', status: 'pending' },
]

const tasks: readonly BackgroundTaskItem[] = [
  { taskId: 'a', description: '索引仓库', status: 'running' },
  { taskId: 'b', description: '执行测试', status: 'completed' },
  { taskId: 'c', description: '生成报告', status: 'failed' },
]

const goal: SessionGoal = {
  objective: '大幅精简注释',
  completionCriterion: null,
  status: 'active',
  turnsUsed: 3,
  tokensUsed: 0,
  wallClockMs: 20 * 60_000 + 11_000,
  receivedAt: Date.now(),
}

describe('task panel labels', () => {
  it('summarizes background lifecycle states', () => {
    expect(backgroundTaskProgressLabel(tasks)).toBe(
      '1 运行中\u2002·\u20021 已完成\u2002·\u20021 已中断',
    )
  })

  it('formats durations with non-zero units only', () => {
    expect(formatDuration(0)).toBe('0秒')
    expect(formatDuration(11)).toBe('11秒')
    expect(formatDuration(20 * 60 + 11)).toBe('20分 11秒')
    expect(formatDuration(3600 + 60)).toBe('1小时 1分')
  })

  it('formats elapsed labels like ZCode background tasks', () => {
    expect(formatElapsed(0)).toBe('已运行 1 秒')
    expect(formatElapsed(11_000)).toBe('已运行 11 秒')
    expect(formatElapsed(20 * 60_000 + 11_000)).toBe('已运行 20 分 11 秒')
  })
})

describe('todo focus window', () => {
  const many: readonly TodoItem[] = [
    { title: 'a', status: 'done' },
    { title: 'b', status: 'done' },
    { title: 'c', status: 'done' },
    { title: 'd', status: 'in_progress' },
    { title: 'e', status: 'pending' },
    { title: 'f', status: 'pending' },
    { title: 'g', status: 'pending' },
    { title: 'h', status: 'pending' },
  ]

  it('shows everything at or below the threshold', () => {
    const window = todoFocusWindow(todos)
    expect(window.compact).toBe(false)
    expect(window.focus).toHaveLength(3)
  })

  it('keeps the running item in a three-row focus and folds the rest', () => {
    const window = todoFocusWindow(many)
    expect(window.compact).toBe(true)
    expect(window.focus.map((item) => item.title)).toEqual(['d', 'e', 'f'])
    expect(window.preceding).toHaveLength(3)
    expect(window.following).toHaveLength(2)
  })

  it('renders fold placeholder rows when compact', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={[]} todos={many} />)
    expect(markup).toContain('已完成 3 项')
    expect(markup).toContain('待处理 2 项')
  })
})

describe('default open rule', () => {
  const git: WorkspaceGitStatus = {
    added: 10,
    ahead: 0,
    behind: 0,
    branch: 'main',
    branches: ['main'],
    busy: false,
    detachedAt: null,
    dirtyFileCount: 1,
    onRefresh: () => undefined,
    removed: 2,
    upstream: null,
  }

  it('opts in only the sections that have content', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent backgroundTasks={[]} git={git} todos={[]} />,
    )
    // Git 出现即展开，其余空区收起。
    expect(markup).toContain('data-value="environment"')
    expect(markup).not.toContain('data-value="todo"')
    expect(markup).not.toContain('data-value="terminals"')
  })

  it('expands 待办事项 when there are todos', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={[]} todos={todos} />)
    expect(markup).toContain('data-value="todo"')
  })

  it('expands 后台任务 when there are tasks', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={tasks} todos={[]} />)
    expect(markup).toContain('data-value="terminals"')
  })
})

describe('status panel sections', () => {
  it('renders 目标 / 待办事项 / 后台任务 sections from one panel', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={tasks}
        goal={goal}
        onPauseGoal={() => undefined}
        onResumeGoal={() => undefined}
        todos={todos}
      />,
    )
    expect(markup).toContain('目标')
    expect(markup).toContain('待办事项')
    expect(markup).toContain('后台任务')
    expect(markup).toContain('大幅精简注释')
    expect(markup).toContain('data-goal-action="pause"')
    expect(markup).toContain('1/3')
  })

  it('drops only the goal section when there is no goal', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={[]} todos={todos} />)
    expect(markup).not.toContain('data-goal-action')
    expect(markup).toContain('待办事项')
    expect(markup).toContain('后台任务')
  })

  /* 两区常驻（空会话里它们仍在），只是默认收起 —— 展开后各说一句「暂无」。 */
  it('keeps both resident sections in the panel even when empty', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={[]} todos={[]} />)
    expect(markup).toContain('待办事项')
    expect(markup).toContain('后台任务')
  })

  it('renders the Git section with +N -M and the branch when there are changes', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[]}
        git={{
          added: 1287,
          ahead: 0,
          behind: 0,
          branch: 'main',
          branches: ['main'],
          busy: false,
          detachedAt: null,
          dirtyFileCount: 13,
          onRefresh: () => undefined,
          removed: 294,
          upstream: 'origin/main',
        }}
        todos={[]}
      />,
    )
    expect(markup).toContain('Git 工具')
    expect(markup).toContain('更改')
    expect(markup).toContain('+1287')
    expect(markup).toContain('-294')
    expect(markup).toContain('main')
    expect(markup).toContain('提交或推送')
  })

  it('keeps the Git section out when the worktree is clean', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[]}
        git={{
          added: 0,
          ahead: 0,
          behind: 0,
          branch: 'main',
          branches: ['main'],
          busy: false,
          detachedAt: null,
          dirtyFileCount: 0,
          onRefresh: () => undefined,
          removed: 0,
          upstream: null,
        }}
        todos={[]}
      />,
    )
    expect(markup).not.toContain('Git 工具')
  })

  it('suppresses the goal section once the goal is complete', () => {
    const done: SessionGoal = { ...goal, status: 'complete' }
    const markup = renderToStaticMarkup(
      <TaskPanelContent backgroundTasks={[]} goal={done} todos={todos} />,
    )
    expect(markup).not.toContain('目标')
  })
})
