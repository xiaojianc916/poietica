import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '@poietica/agent-contract'
import { allItems } from '../timeline-contract'
import { activeScope, pendingPermission, selectIsBusy } from '../timeline-queries'
import { replayRunEvents } from '../timeline-reducer'

const REQUESTED: RunEvent = {
  kind: 'permission_requested',
  seq: 1,
  at: 1_000,
  requestId: 'req-1',
  title: '允许读取 D:/poietica/README.md ?',
}

const RESOLVED: RunEvent = {
  kind: 'permission_resolved',
  seq: 2,
  at: 1_100,
  requestId: 'req-1',
  decision: 'approved',
  scope: 'session',
}

describe('permission flow', () => {
  it('blocks the run on an unanswered question', () => {
    const state = replayRunEvents([REQUESTED])
    const pending = pendingPermission(activeScope(state))

    expect(state.status).toBe('awaiting_permission')
    expect(selectIsBusy(state)).toBe(true)

    /* 答一次需要的只有号：kap 的审批请求不带选项表，按钮上的字由产品定。 */
    expect(pending?.requestId).toBe('req-1')
    expect(pending?.resolution).toBeUndefined()
  })

  it('stops pending once the answer is recorded', () => {
    const state = replayRunEvents([REQUESTED, RESOLVED])

    expect(pendingPermission(activeScope(state))).toBeUndefined()
    expect(state.status).toBe('running')
    expect(allItems(state)).toHaveLength(1)
  })

  it('ignores a replayed answer', () => {
    const once = replayRunEvents([REQUESTED, RESOLVED])
    const twice = replayRunEvents([REQUESTED, RESOLVED, RESOLVED])

    expect(allItems(twice)).toStrictEqual(allItems(once))
    expect(twice.lastSeq).toBe(once.lastSeq)
  })
})
