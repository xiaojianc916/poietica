import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import type { TimelineState } from '../timeline-contract'
import { appendUserMessage, applyRunEvent, createTimelineState } from '../timeline-reducer'

/*
 * A conversation is not a run.
 *
 * Almost every case here is a second turn, because that is where a state
 * modelled as one run falls apart: the sequence numbers start again, the tool
 * call ids repeat, and anything keyed on them alone overwrites the turn before
 * it. The first case is the one the user sees first: what they said, before any
 * frame has come back.
 */

function started(seq: number, prompt: string): RunEvent {
  return { kind: 'run_started', seq, at: seq, sessionId: 'sess', prompt }
}

function spoke(seq: number, text: string): RunEvent {
  return { kind: 'kap_event', seq, at: seq, payload: { type: 'assistant.delta', delta: text } }
}

function called(seq: number, toolCallId: string): RunEvent {
  return {
    kind: 'kap_event',
    seq,
    at: seq,
    payload: { type: 'tool.call.started', toolCallId, name: 'Read' },
  }
}

function finished(seq: number): RunEvent {
  return { kind: 'run_finished', seq, at: seq, stopReason: 'completed' }
}

function turn(state: TimelineState, prompt: string, events: readonly RunEvent[]): TimelineState {
  let next = appendUserMessage(state, prompt, 1)
  for (const event of events) {
    next = applyRunEvent(next, event)
  }
  return next
}

function saidIn(state: TimelineState): readonly string[] {
  return state.items.flatMap((item) => (item.type === 'user_message' ? [item.text] : []))
}

describe('a conversation of several turns', () => {
  it('shows the question before a single frame has come back', () => {
    const state = appendUserMessage(createTimelineState(), '读取 README', 5)

    expect(saidIn(state)).toEqual(['读取 README'])
    expect(state.status).toBe('submitted')
  })

  it('shows it once when the run reports the prompt back', () => {
    const asked = appendUserMessage(createTimelineState(), '读取 README', 5)
    const running = applyRunEvent(asked, started(1, '读取 README'))

    /* The live entry and the recorded one are the same question. */
    expect(saidIn(running)).toEqual(['读取 README'])
  })

  it('keeps the question when the run never starts', () => {
    const asked = appendUserMessage(createTimelineState(), '读取 README', 5)
    const failed = applyRunEvent(asked, {
      kind: 'run_failed',
      seq: asked.lastSeq + 1,
      at: 6,
      message: '助手无法启动',
    })

    expect(failed.items.map((item) => item.type)).toEqual(['user_message', 'error'])
  })

  it('keeps the first turn when a second one begins', () => {
    const first = turn(createTimelineState(), '第一个问题', [
      started(1, '第一个问题'),
      spoke(2, '好'),
      finished(3),
    ])
    const second = turn(first, '第二个问题', [
      started(1, '第二个问题'),
      spoke(2, '再好'),
      finished(3),
    ])

    expect(saidIn(second)).toEqual(['第一个问题', '第二个问题'])
    expect(second.items).toHaveLength(4)

    /* The feed keys rows by id, and a virtualiser cannot survive a collision. */
    expect(new Set(second.items.map((item) => item.id)).size).toBe(second.items.length)
  })

  it('gives each turn its own tool call, however the agent numbers them', () => {
    const first = turn(createTimelineState(), '第一个问题', [
      started(1, '第一个问题'),
      called(2, '0:Read_0'),
      finished(3),
    ])
    const second = turn(first, '第二个问题', [
      started(1, '第二个问题'),
      called(2, '0:Read_0'),
      finished(3),
    ])

    expect(second.items.filter((item) => item.type === 'tool_call')).toHaveLength(2)
  })
})
