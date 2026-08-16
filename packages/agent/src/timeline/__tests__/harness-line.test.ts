import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { applyRunEvents, createTimelineState } from '../timeline-reducer'

/**
 * harness 那条线的帧必须落成条目。
 *
 * 这不是一次形状检查：契约缺这一格的时候，每一帧照旧推进 lastSeq 窗口却一格条目
 * 都不落，于是整轮空白、末尾只剩一句 stopReason —— 而屏幕上看不出任何东西出错。
 */
describe('harness 会话日志', () => {
  const session = 'S' as RunEvent extends { sessionId: infer T } ? T : never

  function frame(seq: number, event: unknown): RunEvent {
    return { kind: 'harness_event', seq, at: seq, sessionId: session, event }
  }

  const turn: readonly RunEvent[] = [
    { kind: 'run_started', seq: 1, at: 1, sessionId: session, prompt: '你好' },
    frame(2, { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } }),
    frame(3, {
      type: 'assistant/chunk',
      seq: 2,
      time: 3,
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想一下' } },
    }),
    frame(4, {
      type: 'assistant/chunk',
      seq: 3,
      time: 4,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '你' } },
    }),
    frame(5, {
      type: 'assistant/chunk',
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '好' } },
    }),
    frame(6, {
      type: 'tool/call',
      seq: 5,
      time: 6,
      data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' },
    }),
    frame(7, {
      type: 'tool/result',
      seq: 6,
      time: 7,
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      },
    }),
    { kind: 'run_finished', seq: 8, at: 8, stopReason: 'end_turn' },
  ]

  it('一轮下来，说过的话、想过的事、动过的手都在转录里', () => {
    const state = applyRunEvents(createTimelineState(), turn)
    const kinds = state.items.map((item) => item.type)

    expect(kinds).toEqual(['user_message', 'agent_thought', 'agent_text', 'tool_call'])

    const said = state.items.find((item) => item.type === 'agent_text')

    /* 同一步的两段文字并成一条，不是两条。 */
    expect(said).toMatchObject({ text: '你好' })

    const call = state.items.find((item) => item.type === 'tool_call')

    expect(call).toMatchObject({
      status: 'completed',
      title: 'read',
      rawInput: { path: 'a.txt' },
    })
  })

  it('有产出的一轮不再报空转', () => {
    const state = applyRunEvents(createTimelineState(), turn)

    expect(state.items.some((item) => item.type === 'error')).toBe(false)
    expect(state.status).toBe('completed')
  })

  it('这条线自己报的失败理由说得出来', () => {
    const state = applyRunEvents(createTimelineState(), [
      ...turn.slice(0, -1),
      frame(8, {
        type: 'turn/end',
        seq: 7,
        time: 8,
        data: { turn: 1, reason: { kind: 'error', error: { message: '额度用尽', code: 'QUOTA' } } },
      }),
      { kind: 'run_finished', seq: 9, at: 9, stopReason: 'end_turn' },
    ])

    expect(state.items.filter((item) => item.type === 'error')).toMatchObject([
      { message: '额度用尽' },
    ])
  })

  it('认不出的词汇不画，也不吞掉后面的帧', () => {
    const state = applyRunEvents(createTimelineState(), [
      ...turn.slice(0, 2),
      frame(3, { type: 'hook/invoked', seq: 2, time: 3, data: {}, ignorable: true }),
      frame(4, {
        type: 'assistant/chunk',
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '在' } },
      }),
    ])

    expect(state.items.map((item) => item.type)).toEqual(['user_message', 'agent_text'])
  })

  it('待办表整份替换，一段里只有一份计划', () => {
    const state = applyRunEvents(createTimelineState(), [
      ...turn.slice(0, 2),
      frame(3, {
        type: 'todo/write',
        seq: 2,
        time: 3,
        data: {
          todos: [
            { content: '读文件', status: 'in_progress' },
            { content: '改文件', status: 'pending' },
          ],
        },
      }),
      frame(4, {
        type: 'todo/write',
        seq: 3,
        time: 4,
        data: {
          todos: [
            { content: '读文件', status: 'completed' },
            { content: '改文件', status: 'in_progress' },
          ],
        },
      }),
    ])

    const plans = state.items.filter((item) => item.type === 'plan')

    /* 后一份不是追加：同一段里始终只有一份计划。 */
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      entries: [
        { content: '读文件', status: 'completed' },
        { content: '改文件', status: 'in_progress' },
      ],
    })
  })

  it('认不出的状态不落，也不拖累同一份计划里的其他步', () => {
    const state = applyRunEvents(createTimelineState(), [
      ...turn.slice(0, 2),
      frame(3, {
        type: 'todo/write',
        seq: 2,
        time: 3,
        data: {
          todos: [
            { content: '读文件', status: 'blocked' },
            { content: '改文件', status: 'pending' },
          ],
        },
      }),
    ])

    const plans = state.items.filter((item) => item.type === 'plan')

    /* 猜成 pending 就是替 agent 编一个它没说过的状态。 */
    expect(plans[0]).toMatchObject({ entries: [{ content: '改文件', status: 'pending' }] })
  })
})
