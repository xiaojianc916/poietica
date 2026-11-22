import { afterEach, expect, test } from 'bun:test'
import { withViewTransition } from '../view-transition'

/* 视图过渡的出口：没有 API、要减少动效时都必须同步落地；有条路时更新必须交进 update 回调（不然补的是同一张图）。 */

/**
 * happy-dom 不实现 View Transition，而浏览器里它是必有的。测试只在这一个成员上装替身 / 摘掉它：
 * 具名一次放宽到 optional，别处都按真实签名用。
 */
const host = document as unknown as { startViewTransition: typeof document.startViewTransition | undefined }
const realStart = host.startViewTransition

interface StubCall {
  readonly types: readonly string[]
}

function installStub(options: { readonly throws?: boolean } = {}): StubCall[] {
  const calls: StubCall[] = []
  host.startViewTransition = (arg) => {
    const object = typeof arg === 'object' && arg !== null && !Array.isArray(arg) ? arg : undefined
    const update = object !== undefined && 'update' in object ? object.update : undefined
    calls.push({ types: object !== undefined && 'types' in object ? (object.types ?? []) : [] })
    /* 文档不可见时浏览器直接抛：helper 必须仍让更新落地，且只跑一次。 */
    if (options.throws === true) throw new Error('document is not visible')
    update?.()
    return {
      types: new Set<string>(),
      updateCallbackDone: Promise.resolve(),
      ready: Promise.resolve(),
      finished: Promise.resolve(),
      skipTransition: () => undefined,
    }
  }
  return calls
}

afterEach(() => {
  delete document.documentElement.dataset.reduceMotion
  host.startViewTransition = realStart
})

test('VT1 没有 API：同步落地，不进过渡', () => {
  host.startViewTransition = undefined
  let ran = 0
  withViewTransition(() => {
    ran += 1
  })
  expect(ran).toBe(1)
})

test('VT2 有条路：更新交进 update 回调，类型名带到浏览器', () => {
  const calls = installStub()
  let ran = 0
  withViewTransition(
    () => {
      ran += 1
    },
    { type: 'ui-route' },
  )
  expect(ran).toBe(1)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.types).toEqual(['ui-route'])
})

test('VT3 不给类型名时传空数组（浏览器默认拿 root 组补间）', () => {
  const calls = installStub()
  withViewTransition(() => undefined)
  expect(calls[0]?.types).toEqual([])
})

test('VT4 外观页要求减少动效：不走过渡，仍然同步落地', () => {
  const calls = installStub()
  document.documentElement.dataset.reduceMotion = 'true'
  let ran = 0
  withViewTransition(() => {
    ran += 1
  })
  expect(ran).toBe(1)
  expect(calls).toHaveLength(0)
})

test('VT5 浏览器抛错（文档不可见）：更新照做，且只做一次', () => {
  installStub({ throws: true })
  let ran = 0
  withViewTransition(() => {
    ran += 1
  })
  expect(ran).toBe(1)
})
