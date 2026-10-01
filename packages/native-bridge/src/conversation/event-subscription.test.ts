import { expect, test } from 'bun:test'
import { subscribeToEvent } from './event-subscription'

/*
 * 订阅本身是同步的：宿主端口直接返回卸载函数，所以没有在途注册要收尾。
 * 这里钉住的两条是转发层的语义，与传输是同步还是异步无关。
 */

/** 订阅时登记下来的那一个处理函数；没登记就说明订阅没生效。 */
function receiver(): {
  readonly take: () => (value: number) => void
  readonly remember: (handler: (value: number) => void) => void
} {
  let handler: ((value: number) => void) | null = null

  return {
    remember: (next) => {
      handler = next
    },
    take: () => {
      if (handler === null) {
        throw new Error('the subscription did not register a handler')
      }

      return handler
    },
  }
}

test('unsubscribing stops delivery exactly once', () => {
  const wire = receiver()
  const delivered: number[] = []
  let released = 0

  const stop = subscribeToEvent<number>(
    (handler) => {
      wire.remember(handler)
      return () => {
        released += 1
      }
    },
    (value) => {
      delivered.push(value)
    },
  )

  wire.take()(1)
  stop()
  wire.take()(2)
  stop()

  expect(released).toBe(1)
  expect(delivered).toEqual([1])
})

test('a failing event consumer does not poison later events', () => {
  const wire = receiver()
  const delivered: number[] = []
  const failures: unknown[] = []
  let released = 0

  const stop = subscribeToEvent<number>(
    (handler) => {
      wire.remember(handler)
      return () => {
        released += 1
      }
    },
    (value) => {
      if (value === 1) {
        throw new Error('Rejected fixture event')
      }
      delivered.push(value)
    },
    (cause) => {
      failures.push(cause)
    },
  )

  wire.take()(1)
  wire.take()(2)
  stop()

  expect(failures).toHaveLength(1)
  expect(delivered).toEqual([2])
  expect(released).toBe(1)
})
