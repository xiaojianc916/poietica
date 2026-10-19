import { describe, expect, test } from 'bun:test'
import { InvariantError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import { TURN_CONTEXT_MAX, TurnContextHub } from '../turn-context'

/* 轮次上下文登记处：别的功能交来「下一句顺带告诉模型的事」，conversation 只负责收齐、交给引擎、回执。 */
describe('TurnContextHub', () => {
  test('按提供方 id 排序收齐；空话与 null 不带；回执逐个回调', () => {
    const hub = new TurnContextHub(createTestLogger())
    const acked: string[] = []
    hub.register({ id: 'zeta', collect: () => ({ text: 'z', delivered: () => acked.push('zeta') }) })
    hub.register({
      id: 'alpha',
      collect: (threadId) => ({ text: `a:${threadId}`, delivered: () => acked.push('alpha') }),
    })
    hub.register({ id: 'blank', collect: () => ({ text: '  ', delivered: () => acked.push('blank') }) })
    hub.register({ id: 'none', collect: () => null })
    const collected = hub.collect('t1')
    expect(collected.blocks).toEqual([
      { source: 'alpha', text: 'a:t1' },
      { source: 'zeta', text: 'z' },
    ])
    expect(acked).toEqual([])
    collected.delivered()
    expect(acked).toEqual(['alpha', 'zeta'])
  })

  test('某一家抛错或超长：只记 warn、不带它那块，其余照常', () => {
    const logger = createTestLogger()
    const hub = new TurnContextHub(logger)
    hub.register({
      id: 'broken',
      collect: () => {
        throw new TypeError('boom')
      },
    })
    hub.register({
      id: 'huge',
      collect: () => ({ text: 'x'.repeat(TURN_CONTEXT_MAX + 1), delivered: () => undefined }),
    })
    hub.register({ id: 'ok', collect: () => ({ text: 'fine', delivered: () => undefined }) })
    expect(hub.collect('t1').blocks).toEqual([{ source: 'ok', text: 'fine' }])
    expect(logger.at('warn').map((r) => r.msg)).toEqual([
      'turn context provider failed: broken',
      'turn context too large, skipped',
    ])
  })

  test('同一 id 不许登记两次；释放之后可以重新登记', () => {
    const hub = new TurnContextHub(createTestLogger())
    const first = hub.register({ id: 'a', collect: () => null })
    expect(() => hub.register({ id: 'a', collect: () => null })).toThrow(InvariantError)
    first.dispose()
    hub.register({ id: 'a', collect: () => ({ text: 'again', delivered: () => undefined }) })
    expect(hub.collect('t').blocks).toEqual([{ source: 'a', text: 'again' }])
  })

  test('退回：每家的 undelivered 都回调；某一家抛错只记 warn，不挡别家', () => {
    const logger = createTestLogger()
    const hub = new TurnContextHub(logger)
    const rolled: string[] = []
    hub.register({
      id: 'a',
      collect: () => ({
        text: 'a',
        delivered: () => undefined,
        undelivered: () => {
          throw new Error('boom')
        },
      }),
    })
    hub.register({ id: 'b', collect: () => ({ text: 'b', delivered: () => undefined }) })
    hub.register({
      id: 'c',
      collect: () => ({ text: 'c', delivered: () => undefined, undelivered: () => rolled.push('c') }),
    })
    hub.collect('t').undelivered()
    expect(rolled).toEqual(['c'])
    expect(logger.at('warn').map((r) => r.msg)).toEqual(['turn context rollback failed'])
  })
})
