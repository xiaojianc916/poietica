import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { RunningStatus } from '../running-status'

/* 运行状态行：文案、三个中点、鲸鱼两层、分隔线只在上面有产出时画。真实布局归 check:ticker 那一族。 */

afterEach(() => {
  cleanup()
})

function mount(props: { startedAt?: number | undefined; divided?: boolean }): HTMLElement {
  const { container } = render(<RunningStatus divided={props.divided ?? false} startedAt={props.startedAt} />)

  return container
}

describe('运行状态行', () => {
  it('有起始时刻：报「深度求索中，用时 N秒 ···」', () => {
    const container = mount({ startedAt: Date.now() - 4_000 })

    /* 不钉死那个数字：秒针读的是时钟模块加载时抓的那一帧（它只在自己报的期限到了才走），
     * 精确的口径归 duration.test.ts。这里钉的是形状与「它确实在报时长」。 */
    expect(container.textContent).toMatch(/深度求索中，用时 \d+秒 \u00b7\u00b7\u00b7/)
  })

  it('没有起始时刻：只报那半句，不报一个假的时长', () => {
    const container = mount({ startedAt: undefined })
    const text = container.textContent ?? ''

    expect(text).toContain('深度求索中')
    expect(text).not.toContain('用时')
  })

  it('结尾是三个 U+00B7，不是省略号：说的是「还在往外冒」，不是「这里被截断了」', () => {
    const container = mount({ startedAt: Date.now() })
    const text = container.textContent ?? ''

    expect(text).toContain('\u00b7\u00b7\u00b7')
    expect(text).not.toContain('\u2026')
  })

  it('上面的产出不是我说的话时才画分隔线', () => {
    expect(mount({ divided: true }).querySelector('.running-status__divider')).not.toBeNull()
    expect(mount({ divided: false }).querySelector('.running-status__divider')).toBeNull()
  })

  it('鲸鱼两层都在，二选一由 CSS 定（动效不被支持时静态那条顶上）', () => {
    const container = mount({ startedAt: Date.now() })

    expect(container.querySelector('.running-status__whale-animated')).not.toBeNull()
    expect(container.querySelector('.running-status__whale-still')).not.toBeNull()
    // 图标不由这一行承担信息：两层都从无障碍树里摘掉。
    expect(container.querySelector('.running-status__icon')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('只给读屏播报那句固定文案：带秒数的可见文案每秒都变，挂 aria-live 会让人停不下来', () => {
    const container = mount({ startedAt: Date.now() - 5_000 })
    const announce = container.querySelector('.running-status__announce')

    expect(announce?.textContent).toBe('深度求索中')
    expect(announce?.getAttribute('role')).toBe('status')
    expect(announce?.getAttribute('aria-live')).toBe('polite')
    // 可见那一行不是 live 区。
    expect(container.querySelector('.running-status__text')?.getAttribute('aria-live')).toBeNull()
  })
})
