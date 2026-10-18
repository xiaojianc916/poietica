import { afterEach, describe, expect, test } from 'bun:test'
import { PICKER_CALLBACK_HOST } from '../../contract/entities'
import { pickerRuntime } from '../picker-runtime'

/* BR-9：注入那一刻的**那份字符串**在 happy-dom 里真跑一遍。宿主用的是 pickerRuntime.toString()，所以自包含是硬要求 ——
 * 函数体里引用任何外部变量，new Function 出来的副本当场就抛 ReferenceError。判据是宿主给的 DOM 契约与 location.assign 收到的地址。 */

const CALLBACK = `https://${PICKER_CALLBACK_HOST}/`

interface Assigned {
  readonly url: string
}

interface Harness {
  readonly assigned: Assigned[]
  readonly location: { assign(url: string): void }
  start(): void
}

function harness(): Harness {
  const assigned: Assigned[] = []
  const location = {
    assign: (url: string): void => {
      assigned.push({ url })
    },
  }

  return {
    assigned,
    location,
    start() {
      const source = `(${pickerRuntime.toString()})`
      const run = new Function(
        'args',
        'location',
        `"use strict"; const window = globalThis; return (${source})(args);`,
      ) as (args: unknown, location: unknown) => void

      run({ token: 'token-1', theme: 'dark', callbackUrl: CALLBACK }, location)
    },
  }
}

function clear(): void {
  for (const node of document.querySelectorAll('[data-poietica-element-picker]')) {
    node.remove()
  }

  delete (window as unknown as { __poieticaElementPicker?: unknown }).__poieticaElementPicker
}

afterEach(clear)

describe('BR-9: pickerRuntime.toString() 在 happy-dom 里执行', () => {
  test('overlay 出现：注入后宿主节点挂上了标记与主题', () => {
    const h = harness()

    h.start()

    const host = document.querySelector('[data-poietica-element-picker]')

    expect(host).not.toBeNull()
    expect(host?.getAttribute('data-theme')).toBe('dark')
  })

  test('预定的全局出口存在：宿主随时可以叫停页面上的拾取', () => {
    const h = harness()

    h.start()

    const scope = window as unknown as { __poieticaElementPicker?: { cancel(): void } }

    expect(typeof scope.__poieticaElementPicker?.cancel).toBe('function')
  })

  test('Esc 触发 location.assign，地址带当前 token 与 kind=cancelled', () => {
    const h = harness()

    h.start()
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))

    expect(h.assigned).toHaveLength(1)
    expect(h.assigned[0]?.url).toContain(PICKER_CALLBACK_HOST)
    expect(h.assigned[0]?.url).toContain('token=token-1')
    expect(h.assigned[0]?.url).toContain('kind=cancelled')
  })
})
