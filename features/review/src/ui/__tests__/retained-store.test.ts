import { describe, expect, test } from 'bun:test'
import { type RetainedStore, retain } from '../retained-store'

describe('按引用计数常驻的 store', () => {
  test('第一个消费者 start，最后一个走掉才 stop 与 release；重复清理无害', () => {
    const calls: string[] = []
    const entry: RetainedStore<{ start(): () => void }> = {
      refs: 0,
      release: () => calls.push('release'),
      stop: null,
      store: {
        start: () => {
          calls.push('start')
          return () => calls.push('stop')
        },
      },
    }

    const first = retain(entry)
    const second = retain(entry)
    expect(calls).toEqual(['start'])

    first()
    expect(calls).toEqual(['start'])

    second()
    expect(calls).toEqual(['start', 'stop', 'release'])

    second()
    expect(calls).toEqual(['start', 'stop', 'release'])
  })

  test('放下之后再有人 retain 会重新 start', () => {
    const calls: string[] = []
    const entry: RetainedStore<{ start(): () => void }> = {
      refs: 0,
      stop: null,
      store: {
        start: () => {
          calls.push('start')
          return () => calls.push('stop')
        },
      },
    }

    retain(entry)()
    retain(entry)()

    expect(calls).toEqual(['start', 'stop', 'start', 'stop'])
  })
})
