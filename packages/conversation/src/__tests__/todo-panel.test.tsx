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

  /* 空表没有可报的档：摘要给空串，由调用方整格不画。 */
  it('reports nothing for an empty background list', () => {
    expect(backgroundTaskProgressLabel([])).toBe('')
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

  /*
   * 子代理进「智能体」那一节，不进「后台任务」。
   *
   * 这一条钉的是此前那条缺陷：投影层只按 detached 分派、没看 kind，子代理于是被列成
   * 一台终端。两节同时断言 —— 只说「在智能体里」的话，两边都画也照样通过。
   */
  it('lists a subagent under 智能体 and never under 后台任务', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[]}
        runningAgents={[{ key: 'Anna', title: '看一遍仓库', startedAt: 0 }]}
        todos={[]}
      />,
    )

    expect(markup).toContain('data-value="agents"')
    expect(markup).toContain('>智能体<')
    expect(markup).toContain('看一遍仓库')
    expect(markup).not.toContain('data-value="terminals"')
    expect(markup).not.toContain('>后台任务<')
  })

  it('keeps a background shell job out of 智能体', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent backgroundTasks={tasks} runningAgents={[]} todos={[]} />,
    )

    expect(markup).toContain('data-value="terminals"')
    expect(markup).not.toContain('data-value="agents"')
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
    expect(markup).toContain('>待办事项<')
    expect(markup).not.toContain('>后台任务<')
  })

  /*
   * 空区整格不提：既不画「暂无」，摘要里也不留一个 0/0。
   * 断言比的是标题元素本身（>标题<），面板的 aria-label 里也有「后台任务」四个字。
   */
  it('keeps empty sections out of the panel entirely', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={[]} todos={[]} />)
    expect(markup).not.toContain('>待办事项<')
    expect(markup).not.toContain('>后台任务<')
    expect(markup).not.toContain('暂无')
    expect(markup).not.toContain('0/0')
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

  it('keeps the Git section out when the host reports no git at all', () => {
    const markup = renderToStaticMarkup(<TaskPanelContent backgroundTasks={[]} todos={[]} />)
    expect(markup).not.toContain('Git 工具')
  })

  /* 干净仓库仍是 git 工作区：这一区恒画，+0 -0 如实报数，不因为「没改动」整格消失。 */
  it('keeps the Git section on a clean worktree', () => {
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
    expect(markup).toContain('Git 工具')
    expect(markup).toContain('+0')
    expect(markup).toContain('-0')
    expect(markup).toContain('main')
    expect(markup).toContain('提交或推送')
  })

  it('suppresses the goal section once the goal is complete', () => {
    const done: SessionGoal = { ...goal, status: 'complete' }
    const markup = renderToStaticMarkup(
      <TaskPanelContent backgroundTasks={[]} goal={done} todos={todos} />,
    )
    expect(markup).not.toContain('目标')
  })
})
