import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '../../agent'
import { applyRunEvents, createTimelineState, replayRunEvents } from '../timeline-reducer'

const prompt: RunEvent = {
  kind: 'prompt_admitted',
  admissionId: 'todo-admission',
  seq: 1,
  at: 1,
  sessionId: 'todo-session',
  prompt: '完成任务',
}

function started(seq: number, id: string, items: readonly unknown[]): RunEvent {
  return {
    kind: 'kap_event',
    seq,
    at: seq,
    payload: {
      type: 'tool.call.started',
      toolCallId: id,
      name: 'TodoList',
      args: { items },
      display: { kind: 'todo_list', items },
    },
  }
}

function settled(seq: number, id: string, isError = false): RunEvent {
  return {
    kind: 'kap_event',
    seq,
    at: seq,
    payload: { type: 'tool.result', toolCallId: id, output: 'ok', isError },
  }
}

const first = [
  { title: '搭骨架', status: 'done' },
  { title: '写组件', status: 'in_progress' },
  { title: '补测试', status: 'pending' },
] as const

describe('todo current snapshot', () => {
  it('publishes a whole-list snapshot only after TodoList succeeds', () => {
    const running = replayRunEvents([prompt, started(2, 'first', first)])
    const completed = replayRunEvents([prompt, started(2, 'first', first), settled(3, 'first')])

    expect(running.todos).toBeNull()
    expect(completed.todos).toStrictEqual(first)
  })

  it('does not let a failed replacement overwrite the last successful list', () => {
    const state = replayRunEvents([
      prompt,
      started(2, 'first', first),
      settled(3, 'first'),
      started(4, 'failed', [{ title: '错误覆盖', status: 'pending' }]),
      settled(5, 'failed', true),
    ])

    expect(state.todos).toStrictEqual(first)
  })

  it('distinguishes an explicit empty replacement from no observed list', () => {
    const state = replayRunEvents([
      prompt,
      started(2, 'first', first),
      settled(3, 'first'),
      started(4, 'clear', []),
      settled(5, 'clear'),
    ])

    expect(state.todos).toStrictEqual([])
  })

  it('produces the same snapshot through live batches and replay', () => {
    const events = [prompt, started(2, 'first', first), settled(3, 'first')]
    let live = createTimelineState()

    for (const event of events) {
      live = applyRunEvents(live, [event])
    }

    expect(live).toStrictEqual(replayRunEvents(events))
  })
})
