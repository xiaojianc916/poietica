import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useDockClearance } from '../dock-clearance'

/* happy-dom 的 ResizeObserver 不回调：换成手摇的，回调由测试在「布局之后、绘制之前」那个位置亲手调。 */
let fire: ((height: number) => void) | null = null
const RealObserver = globalThis.ResizeObserver

beforeEach(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      fire = (height) => {
        this.callback(
          [{ borderBoxSize: [{ blockSize: height, inlineSize: 0 }] } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
    }
    unobserve() {}
    disconnect() {
      fire = null
    }
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = RealObserver
})

function Probe() {
  const clearance = useDockClearance(true)

  return (
    <>
      <div ref={clearance.ref} />
      <output>{String(clearance.value)}</output>
    </>
  )
}

test('输入区变高变矮：同一个回调里就发布出去（转录的留白与它同一帧画），不排到下一帧', () => {
  const { container } = render(<Probe />)

  fire?.(88)

  expect(container.querySelector('output')?.textContent).toBe('88')
})
