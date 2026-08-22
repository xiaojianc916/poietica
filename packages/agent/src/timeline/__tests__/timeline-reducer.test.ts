import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { allItems } from '../timeline-contract'
import { applyRunEvent, createTimelineState, replayRunEvents } from '../timeline-reducer'

describe('timeline reducer', () => {
  it('projects a recorded run into a flat timeline', () => {
    const state = replayRunEvents(SAMPLE_RUN_EVENTS)

    expect(state.status).toBe('completed')
    expect(allItems(state).map((item) => item.type)).toEqual([
      'user_message',
      'agent_thought',
      'tool_call',
      'agent_text',
    ])

    const thought = allItems(state).find((item) => item.type === 'agent_thought')
    expect(thought && thought.type === 'agent_thought' && thought.text).toBe(
      '先读取 README，再与 package.json 对照。',
    )

    const tool = allItems(state).find((item) => item.type === 'tool_call')
    expect(tool && tool.type === 'tool_call' && tool.status).toBe('completed')
    expect(tool && tool.type === 'tool_call' && tool.endedAt).toBe(1_090)
  })

  it('leaves the result where the frame put it', () => {
    const state = replayRunEvents(SAMPLE_RUN_EVENTS)
    const tool = allItems(state).find((item) => item.type === 'tool_call')

    /* tool.result 送的是 output，落在 rawOutput。把它搬进 content 就是这一层
       替帧决定屏幕上显示什么。 */
    expect(tool && tool.type === 'tool_call' && tool.rawOutput).toBe('# Poietica ...')
    expect(tool && tool.type === 'tool_call' && tool.content).toEqual([])
  })

  it('is idempotent under duplicated events', () => {
    const once = replayRunEvents(SAMPLE_RUN_EVENTS)
    const twice = replayRunEvents([...SAMPLE_RUN_EVENTS, ...SAMPLE_RUN_EVENTS])

    expect(allItems(twice)).toEqual(allItems(once))
    expect(twice.status).toBe(once.status)
  })

  it('keeps a result that arrives before the call was announced', () => {
    const orphan: RunEvent = {
      kind: 'kap_event',
      seq: 1,
      at: 10,
      payload: { type: 'tool.result', toolCallId: 'call_x', output: 'ok' },
    }

    const state = applyRunEvent(createTimelineState(), orphan)
    const tool = allItems(state).at(0)

    expect(tool && tool.type === 'tool_call' && tool.toolCallId).toBe('call_x')
    expect(tool && tool.type === 'tool_call' && tool.status).toBe('completed')
  })
})
