import { describe, expect, test } from 'bun:test'
import type { CoreReadyContext } from '@poietica/ui-kernel'
import { coreSessionOf, createCoreSession } from '../core-session'

function lifecycle() {
  const ready: (() => void)[] = []
  const lost: (() => void)[] = []
  return {
    lifecycle: {
      onCoreReady: (fn: (scope: CoreReadyContext) => void | Promise<void>) => {
        ready.push(() => void fn({ signal: new AbortController().signal }))
      },
      onCoreLost: (fn: () => void) => {
        lost.push(fn)
      },
    },
    ready: () => {
      for (const fn of ready) fn()
    },
    lose: () => {
      for (const fn of lost) fn()
    },
  }
}

describe('CoreSession：Core 的第几世', () => {
  test('首次就绪不算换世；丢一次再就绪才通知，且只通知一次', () => {
    const core = lifecycle()
    const session = createCoreSession(core.lifecycle)
    let renewed = 0
    session.onRenewed(() => {
      renewed += 1
    })
    core.ready()
    expect(renewed).toBe(0)
    core.lose()
    expect(session.generation()).toBe(1)
    core.ready()
    core.ready()
    expect(renewed).toBe(1)
  })

  test('退订之后不再通知', () => {
    const core = lifecycle()
    const session = createCoreSession(core.lifecycle)
    let renewed = 0
    const off = session.onRenewed(() => {
      renewed += 1
    })
    off()
    core.lose()
    core.ready()
    expect(renewed).toBe(0)
  })

  test('按功能上下文各一份', () => {
    const ctx = { lifecycle: lifecycle().lifecycle }
    expect(coreSessionOf(ctx)).toBe(coreSessionOf(ctx))
    expect(coreSessionOf({ lifecycle: lifecycle().lifecycle })).not.toBe(coreSessionOf(ctx))
  })
})
