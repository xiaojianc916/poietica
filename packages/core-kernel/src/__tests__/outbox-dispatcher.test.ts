import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { fakeClock } from '@poietica/test-kit'
import { createOutbox } from '../outbox'
import { createOutboxDispatcher } from '../outbox-dispatcher'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this
  },
}

describe('outbox dispatcher', () => {
  test('按 topic 调 handler；失败退避，未知 topic 不丢', async () => {
    const clock = fakeClock(1_000)
    const db = openDatabase(':memory:')
    const outbox = createOutbox(db, { clock })
    const seen: unknown[] = []
    outbox.enqueue({ topic: 'ok', payload: { n: 1 } })
    outbox.enqueue({ topic: 'boom', payload: null })
    outbox.enqueue({ topic: 'missing', payload: null })
    const dispatcher = createOutboxDispatcher({
      outbox,
      clock,
      logger,
      retryDelayMs: 5_000,
      handlers: [
        { topic: 'ok', handle: (payload) => void seen.push(payload) },
        {
          topic: 'boom',
          handle: () => {
            throw new Error('nope')
          },
        },
      ],
    })
    expect(await dispatcher.tick()).toBe(3)
    expect(seen).toEqual([{ n: 1 }])
    expect(outbox.pendingCount()).toBe(2)

    clock.advance(5_000)
    expect(await dispatcher.tick()).toBe(2)
    db.close()
  })
})
