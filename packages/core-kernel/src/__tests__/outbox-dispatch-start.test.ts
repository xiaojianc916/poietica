import { describe, expect, test } from 'bun:test'
import type { CoreModule } from '../module'
import { makeKernel } from './helpers'

const TOPIC = 'test.workspace'

describe('kernel outbox dispatcher', () => {
  test('模块注册的 handler 在启动后由分发器投递', async () => {
    const delivered: unknown[] = []
    const trigger: { run?: () => void } = {}
    const module: CoreModule = {
      id: 'outboxer',
      setup(ctx) {
        ctx.outboxHandlers.register(TOPIC, (payload) => {
          delivered.push(payload)
        })
        trigger.run = () => {
          ctx.outbox.enqueue({ topic: TOPIC, payload: { workspaceId: 'w1' } })
        }
      },
    }
    const h = await makeKernel([module], { outboxDispatch: true })
    trigger.run!()
    await h.clock.advanceAsync(300)
    expect(delivered).toEqual([{ workspaceId: 'w1' }])
    await h.dispose()
  })

  test('handler 抛错按退避重试，成功后只完成一次', async () => {
    const delivered: unknown[] = []
    const trigger: { run?: () => void } = {}
    let attempts = 0
    const module: CoreModule = {
      id: 'outboxer',
      setup(ctx) {
        ctx.outboxHandlers.register(TOPIC, (payload) => {
          attempts += 1
          if (attempts === 1) throw new Error('第一次失败')
          delivered.push(payload)
        })
        trigger.run = () => {
          ctx.outbox.enqueue({ topic: TOPIC, payload: { workspaceId: 'w1' } })
        }
      },
    }
    const h = await makeKernel([module], { outboxDispatch: true })
    trigger.run!()
    await h.clock.advanceAsync(300)
    expect(attempts).toBe(1)
    await h.clock.advanceAsync(30_000)
    expect(attempts).toBe(2)
    expect(delivered).toEqual([{ workspaceId: 'w1' }])
    await h.clock.advanceAsync(30_000)
    expect(attempts).toBe(2)
    await h.dispose()
  })

  test('同一个 topic 的多个消费者都收到同一条记录', async () => {
    const seen: string[] = []
    const trigger: { run?: () => void } = {}
    const consumer = (id: string): CoreModule => ({
      id,
      setup(ctx) {
        ctx.outboxHandlers.register(TOPIC, () => {
          seen.push(id)
        })
        if (id === 'a') {
          trigger.run = () => {
            ctx.outbox.enqueue({ topic: TOPIC, payload: null })
          }
        }
      },
    })
    const h = await makeKernel([consumer('a'), consumer('b')], { outboxDispatch: true })
    trigger.run!()
    await h.clock.advanceAsync(300)
    expect(seen.sort()).toEqual(['a', 'b'])
    await h.dispose()
  })
})
