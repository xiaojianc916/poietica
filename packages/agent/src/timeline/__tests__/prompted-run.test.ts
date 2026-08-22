import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { applyRunEvent, createTimelineState } from '../timeline-reducer'

/*
 * The question is shown because it was recorded.
 *
 * 这些帧就是 recorder 写下的形状 —— 它由原生侧的 RunFrame 在编译期定下，所以
 * 一个改名的字段会让这里的投影落空，而不是让屏幕上的对话悄悄变空。
 */

describe('a run that carries its prompt', () => {
  it('opens the timeline with what the user said', () => {
    const started: RunEvent = {
      kind: 'run_started',
      seq: 1,
      at: 1_000,
      sessionId: 'sess_alpha',
      prompt: '读取 README',
    }

    const state = applyRunEvent(createTimelineState(), started)
    const first = state.items.at(0)

    expect(state.status).toBe('submitted')
    expect(first && first.type === 'user_message' && first.text).toBe('读取 README')
  })

  it('adds nothing when an older recording carries no prompt', () => {
    const started: RunEvent = {
      kind: 'run_started',
      seq: 1,
      at: 1_000,
      sessionId: 'sess_alpha',
    }

    expect(applyRunEvent(createTimelineState(), started).items).toEqual([])
  })
})
