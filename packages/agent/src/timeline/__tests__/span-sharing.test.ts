import { describe, expect, it } from 'bun:test'
import { appendChunk, draftOf, freeze, markTurnEnd, push } from '../timeline-draft'
import { createTimelineState } from '../timeline-reducer'

describe('timeline span structural sharing', () => {
  it('shares spans while text grows and copies them before lifecycle changes', () => {
    const draft = draftOf(createTimelineState())
    push(draft, {
      type: 'agent_text',
      id: 'r0-agent-1',
      turn: 0,
      at: 1,
      text: 'a',
      sealed: false,
    })
    const first = freeze(draft)

    const growing = draftOf(first)
    appendChunk(growing, 'agent_text', { at: 2, id: 'unused', text: 'b' })
    const second = freeze(growing)

    expect(second.spans).toBe(first.spans)

    const closing = draftOf(second)
    markTurnEnd(closing, 3)
    const ended = freeze(closing)

    expect(ended.spans).not.toBe(second.spans)
    expect(ended.spans.at(-1)?.endedAt).toBe(3)
  })
})
