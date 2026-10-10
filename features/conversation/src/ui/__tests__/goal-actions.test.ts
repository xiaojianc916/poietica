import { describe, expect, test } from 'bun:test'
import type { Controls } from '@poietica/engine'
import { AppError } from '@poietica/foundation'
import { type GoalActionApi, runGoalAction } from '../goal-actions'

/*
 * 目标动作的路由与失败折叠（审查 R-10）：四个动作各走各的 RPC；
 * 永不 reject —— AppError 用它的 message，其余走 describeFailure。
 */

type Call = readonly [method: string, threadId: string, goal?: string | null]

function apiOf(fail?: unknown): { api: GoalActionApi; calls: Call[] } {
  const calls: Call[] = []
  const answer = (): Promise<Controls> => (fail === undefined ? Promise.resolve({} as Controls) : Promise.reject(fail))
  return {
    calls,
    api: {
      setGoal: (threadId, goal) => {
        calls.push(['setGoal', threadId, goal])
        return answer()
      },
      pauseGoal: (threadId) => {
        calls.push(['pauseGoal', threadId])
        return answer()
      },
      resumeGoal: (threadId) => {
        calls.push(['resumeGoal', threadId])
        return answer()
      },
    },
  }
}

describe('runGoalAction（审查 R-10）', () => {
  test('RA1 四个动作各走各的 RPC', async () => {
    const { api, calls } = apiOf()
    expect(await runGoalAction(api, 't1', { kind: 'pause' })).toEqual({ ok: true })
    expect(await runGoalAction(api, 't1', { kind: 'resume' })).toEqual({ ok: true })
    expect(await runGoalAction(api, 't1', { kind: 'edit', objective: '新正文' })).toEqual({ ok: true })
    expect(await runGoalAction(api, 't1', { kind: 'clear' })).toEqual({ ok: true })
    expect(calls).toEqual([
      ['pauseGoal', 't1'],
      ['resumeGoal', 't1'],
      ['setGoal', 't1', '新正文'],
      ['setGoal', 't1', null],
    ])
  })

  test('RA2 Core 抛的 AppError：原样用它的 message', async () => {
    const { api } = apiOf(new AppError('kernel.not_found', '这条对话没有进行中的目标'))
    expect(await runGoalAction(api, 't1', { kind: 'pause' })).toEqual({
      ok: false,
      error: '这条对话没有进行中的目标',
    })
  })

  test('RA3 其余失败：describeFailure 原样（不吞、不改写），且不 reject', async () => {
    expect(await runGoalAction(apiOf(new Error('boom')).api, 't1', { kind: 'resume' })).toEqual({
      ok: false,
      error: 'Error: boom',
    })
    expect(await runGoalAction(apiOf('断了').api, 't1', { kind: 'clear' })).toEqual({ ok: false, error: '断了' })
  })
})
