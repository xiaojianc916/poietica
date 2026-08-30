import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '@poietica/agent-contract'
import { allItems } from '../timeline-contract'
import { applyRunEvent, createTimelineState } from '../timeline-reducer'

/* 枚举改版前落库的帧拿 linked 记「接回来了」。这些行还在 run_events 里，
   重开一条对话就要原样重放它们 —— 投影必须收得下，而不是把屏幕砸了。 */

const retrying = (seq: number): RunEvent => ({
  kind: 'link_changed',
  seq,
  at: 1_000 + seq,
  link: { state: 'retrying', attempt: 1, of: 5, retryAt: 2_000, reason: '连接被重置' },
})

const legacyLinked = (seq: number): RunEvent =>
  ({
    kind: 'link_changed',
    seq,
    at: 1_000 + seq,
    link: { state: 'linked' },
  }) as unknown as RunEvent

function lastLink(state: ReturnType<typeof createTimelineState>) {
  const link = allItems(state).at(-1)

  expect(link?.type).toBe('link')

  return link?.type === 'link' ? link.link : undefined
}

describe('link events recorded before the enum change', () => {
  it('closes an open round as recovered, keeping the last failure reason', () => {
    let state = applyRunEvent(createTimelineState(), retrying(1))
    state = applyRunEvent(state, legacyLinked(2))

    expect(lastLink(state)).toEqual({ state: 'recovered', reason: '连接被重置' })
  })

  it('drops a linked marker with no open round', () => {
    const state = applyRunEvent(createTimelineState(), legacyLinked(1))

    expect(allItems(state)).toEqual([])
  })
})
