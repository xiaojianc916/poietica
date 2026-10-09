import { describe, expect, test } from 'bun:test'
import { type AppError, defineServiceToken, SystemErrorCode } from '@poietica/foundation'
import { defineCoreModule } from '../module'
import { makeKernel } from './helpers'

/*
 * 06 页 §2.1 的文件清单要求内核层有一份 services.test.ts：foundation 的
 * `service-registry.test.ts` 管通用规则，这里钉住**内核把它接进模块 ctx 之后**的判据
 * （受限视图按 dependsOn 生效、内核自己能读所有模块的服务）。
 */

describe('core-kernel 服务装配', () => {
  test('模块只能提供自己 owner 的令牌；拿别人的令牌 provide → kernel.service_access_denied', async () => {
    const foreign = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    let caught: unknown
    await makeKernel([
      defineCoreModule({
        id: 'beta',
        setup: (ctx) => {
          try {
            ctx.services.provide(foreign, { v: 1 })
          } catch (e) {
            caught = e
          }
        },
      }),
    ])
    expect((caught as AppError)?.code).toBe(SystemErrorCode.serviceAccessDenied)
  })

  test('dependsOn 表达的允许集合决定 tryGet：未声明返回 access_denied，声明了但未提供返回 undefined', async () => {
    const alpha = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    const errors: string[] = []
    let optional: { v: number } | undefined = { v: -1 }
    await makeKernel([
      defineCoreModule({ id: 'alpha', setup: () => undefined }),
      defineCoreModule({
        id: 'beta',
        dependsOn: ['alpha'],
        setup: (ctx) => {
          optional = ctx.services.tryGet(alpha)
        },
      }),
      defineCoreModule({
        id: 'gamma',
        setup: (ctx) => {
          try {
            ctx.services.tryGet(alpha)
          } catch (e) {
            errors.push((e as AppError).code)
          }
        },
      }),
    ])
    expect(optional).toBeUndefined()
    expect(errors).toEqual([SystemErrorCode.serviceAccessDenied])
  })

  test('内核服务视图（kernel.services）能读任意模块提供的服务', async () => {
    const alpha = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.services.provide(alpha, { v: 7 })
        },
      }),
    ])
    expect(h.kernel.services.get(alpha)).toEqual({ v: 7 })
    await h.dispose()
  })
})
