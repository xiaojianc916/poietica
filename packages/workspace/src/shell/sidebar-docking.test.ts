import { describe, expect, it } from 'vitest'
import { createDockingStore, type ViewportProbe } from './sidebar-docking'

function fakeViewport(initial: number) {
  let width = initial
  const reports = new Set<(width: number) => void>()

  const probe: ViewportProbe = {
    measure: () => width,
    observe: (report) => {
      reports.add(report)

      return () => {
        reports.delete(report)
      }
    },
  }

  /* 先改几何再报数 —— 与 ResizeObserver 的顺序一致。 */
  const resize = (next: number): void => {
    width = next

    for (const report of reports) {
      report(next)
    }
  }

  return { probe, resize }
}

describe('createDockingStore', () => {
  it('窄到放不下就收起，宽回来还原', () => {
    const host = fakeViewport(1400)
    const store = createDockingStore(host.probe)

    store.subscribe(() => {})

    expect(store.read()).toBe(true)

    host.resize(880)

    expect(store.read()).toBe(false)

    host.resize(1400)

    expect(store.read()).toBe(true)
  })

  /* 关键回归：最小化的 0 宽不算一次跨越，还原时因此没有状态变化可以补间。 */
  it('视口宽 0 不改答案', () => {
    const host = fakeViewport(1400)
    const store = createDockingStore(host.probe)
    let notified = 0

    store.subscribe(() => {
      notified += 1
    })

    host.resize(0)

    expect(store.read()).toBe(true)
    expect(notified).toBe(0)

    host.resize(1400)

    expect(store.read()).toBe(true)
    expect(notified).toBe(0)
  })

  it('答案没变就不通知：useSyncExternalStore 靠这条免于重渲', () => {
    const host = fakeViewport(1400)
    const store = createDockingStore(host.probe)
    let notified = 0

    store.subscribe(() => {
      notified += 1
    })

    host.resize(1200)

    expect(notified).toBe(0)

    host.resize(880)

    expect(notified).toBe(1)
  })
})
