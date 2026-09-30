import { describe, expect, test } from 'bun:test'
import type { AgentTranscriptSnapshot, TranscriptTask } from '@poietica/transcript'
import { projectTranscript } from './transcript-projector'

/*
 * 子代理落哪一节。
 *
 * 此前那条缺陷：投影层只按 `detached` 分派，完全没看 `kind` —— 于是每个子代理都落进
 * 「后台任务」那一节（它的图标是终端、值叫 terminals），而「智能体」那一节只有
 * delegate 工具调用。人看到的是自己的子代理被列成了一台终端。
 *
 * 判据是 `kind === 'subagent'`：detached 只说「父轮不等它」，同步子代理同样属于
 * 「智能体」。
 */

function task(overrides: Partial<TranscriptTask> & Pick<TranscriptTask, 'taskId'>): TranscriptTask {
  return {
    kind: 'subagent',
    state: 'running',
    detached: false,
    outputTail: '',
    ...overrides,
  }
}

function snapshot(tasks: readonly TranscriptTask[]): AgentTranscriptSnapshot {
  return { items: [], tasks, interactions: [], attachments: [], todos: [], prompts: [], meta: {} }
}

describe('subagents are agents, not background tasks', () => {
  test('a detached subagent lands in the agent section, not the terminal one', () => {
    const state = projectTranscript(
      snapshot([
        task({
          taskId: 'Anna',
          agentId: 'Anna',
          detached: true,
          description: '看一遍仓库',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
      ]),
    )

    expect(state.subagents.map((agent) => agent.agentId)).toEqual(['Anna'])
    // 这一条就是那条缺陷：detached 的子代理不该出现在后台任务里。
    expect(state.backgroundTasks).toEqual([])
  })

  test('a synchronous subagent is still an agent', () => {
    // 同步子代理父轮等它，但官方 TUI 的 HUD 一样列它。
    const state = projectTranscript(snapshot([task({ taskId: 'Bob', agentId: 'Bob' })]))

    expect(state.subagents.map((agent) => agent.agentId)).toEqual(['Bob'])
    expect(state.backgroundTasks).toEqual([])
  })

  test('a detached shell job stays a background task', () => {
    const state = projectTranscript(
      snapshot([task({ taskId: 'job-1', kind: 'shell', detached: true, description: '跑测试' })]),
    )

    expect(state.backgroundTasks.map((job) => job.taskId)).toEqual(['job-1'])
    expect(state.subagents).toEqual([])
  })

  test('a non-detached shell job is in neither section', () => {
    // 前台命令不是后台任务：列出来会凭空多一行「后台」。
    const state = projectTranscript(snapshot([task({ taskId: 'job-2', kind: 'shell' })]))

    expect(state.backgroundTasks).toEqual([])
    expect(state.subagents).toEqual([])
  })

  test('the agent id survives even when the row carries no description', () => {
    const state = projectTranscript(snapshot([task({ taskId: 'Anna-2', agentId: 'Anna-2' })]))

    // 描述缺席时退回号：宁可显示一个号，也不能是空行。
    expect(state.subagents[0]).toMatchObject({ agentId: 'Anna-2', description: 'Anna-2' })
  })

  test('both kinds coexist without crossing sections', () => {
    const state = projectTranscript(
      snapshot([
        task({ taskId: 'Anna', agentId: 'Anna', detached: true, description: '子代理' }),
        task({ taskId: 'job-1', kind: 'shell', detached: true, description: '后台命令' }),
      ]),
    )

    expect(state.subagents.map((agent) => agent.agentId)).toEqual(['Anna'])
    expect(state.backgroundTasks.map((job) => job.taskId)).toEqual(['job-1'])
  })
})
