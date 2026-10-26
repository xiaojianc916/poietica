import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { agentRows, TaskPanelContent } from '../todo-panel'

/* 状态面板的「智能体 / 后台任务」两格：数据到了就画，行能点开子代理，运行中的作业能停。 */

const delegate = (toolCallId: string, status: ToolCallTimelineItem['status'], agents: readonly string[]) =>
  ({
    type: 'tool_call',
    id: toolCallId,
    turn: 1,
    at: 0,
    toolCallId,
    title: `派发 ${toolCallId}`,
    invokedTool: 'task',
    scheme: '',
    kind: 'delegate',
    headline: '',
    subject: '',
    shape: 'generic',
    status,
    requestContent: [],
    content: [],
    locations: [],
    channels: agents.map((agentId) => ({ agentId, name: `子代理 ${agentId}` })),
    startedAt: 10,
  }) as unknown as ToolCallTimelineItem

describe('agentRows', () => {
  test('有生命周期帧时按帧分运行 / 已结束，每行带 agentId', () => {
    const rows = agentRows(
      [
        { agentId: '0-A', description: '查资料', status: 'running', startedAt: 5 },
        { agentId: '0-B', description: '写代码', status: 'completed', startedAt: 3 },
      ],
      { finished: [], running: [] },
    )

    expect(rows.running.map((row) => [row.agentId, row.title])).toEqual([['0-A', '查资料']])
    expect(rows.ended.map((row) => [row.agentId, row.status])).toEqual([['0-B', 'completed']])
  })

  test('没有帧时退回派发调用：一次调用派出几个子代理就拆成几行', () => {
    const rows = agentRows([], {
      finished: [delegate('c1', 'failed', ['0-X'])],
      running: [delegate('c2', 'in_progress', ['0-Y', '0-Z']), delegate('c3', 'pending', [])],
    })

    expect(rows.running.map((row) => row.agentId)).toEqual(['0-Y', '0-Z', undefined])
    expect(rows.running[0]?.title).toBe('子代理 0-Y')
    expect(rows.ended.map((row) => [row.agentId, row.status])).toEqual([['0-X', 'failed']])
  })
})

describe('面板渲染', () => {
  test('子代理行有出口时是按钮；已结束入口是可展开的按钮', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[]}
        endedAgents={[{ key: 'b', title: '写代码', startedAt: 1, agentId: '0-B', status: 'completed' }]}
        onOpenAgent={() => undefined}
        runningAgents={[{ key: 'a', title: '查资料', startedAt: 1, agentId: '0-A' }]}
        todos={[]}
      />,
    )

    expect(markup).toContain('data-agent-id="0-A"')
    expect(markup).toContain('data-agent-action="toggle-ended"')
    expect(markup).toContain('aria-expanded="false"')
  })

  test('没有出口时子代理行只是一行字', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[]}
        runningAgents={[{ key: 'a', title: '查资料', startedAt: 1, agentId: '0-A' }]}
        todos={[]}
      />,
    )

    expect(markup).toContain('查资料')
    expect(markup).not.toContain('data-agent-id')
  })

  test('后台任务：运行中的有停止键，已结束的没有', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[
          { taskId: 'job:1', description: 'bun test', status: 'running', startedAt: 1 },
          { taskId: 'job:2', description: 'bun build', status: 'completed', startedAt: 1, endedAt: 2 },
        ]}
        onStopTask={() => undefined}
        todos={[]}
      />,
    )

    expect(markup).toContain('后台任务')
    expect(markup.match(/data-task-action="stop"/g)?.length).toBe(1)
    expect(markup).toContain('停止「bun test」')
  })

  test('待办到了就画，带完成计数', () => {
    const markup = renderToStaticMarkup(
      <TaskPanelContent
        backgroundTasks={[]}
        todos={[
          { title: '读代码', status: 'done' },
          { title: '改代码', status: 'in_progress' },
        ]}
      />,
    )

    expect(markup).toContain('待办事项')
    expect(markup).toContain('1/2')
    expect(markup).toContain('改代码')
  })
})
