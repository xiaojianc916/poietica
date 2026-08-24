import { describe, expect, it } from 'vitest'
import { createDockingStore, type ViewportProbe } from './sidebar-docking'

function fakeHost(initial: { room: boolean; hidden?: boolean }) {
  let room = initial.room
  let hidden = initial.hidden ?? false
  const listeners = new Set<() => void>()

  const probe: ViewportProbe = {
    hasRoom: () => room,
    isHidden: () => hidden,
    watch: (notify) => {
      listeners.add(notify)

      return () => {
        listeners.delete(notify)
      }
    },
  }

  /* 宿主先改几何或呈现状态，再广播一次 —— 与真实探针的顺序一致。 */
  const emit = (next: { room?: boolean; hidden?: boolean }): void => {
    room = next.room ?? room
    hidden = next.hidden ?? hidden

    for (const notify of listeners) {
      notify()
    }
  }

  return { emit, probe }
}

describe('createDockingStore', () => {
  it('窄到放不下就当场收起，宽回来当场还原', () => {
    const host = fakeHost({ room: true })
    const store = createDockingStore(host.probe)

    store.subscribe(() => {})

    expect(store.read()).toBe(true)

    host.emit({ room: false })

    expect(store.read()).toBe(false)

    host.emit({ room: true })

    expect(store.read()).toBe(true)
  })

  /*
   * 关键回归：最小化期间的读数不作数，但那次跨越不能被丢掉 —— 还原时的通知
   * 必须把答案纠正过来。丢一次就是永久丢一次，自动收起因此时好时坏。
   */
  it('最小化期间不改答案，还原后补上那次跨越', () => {
    const host = fakeHost({ room: true })
    const store = createDockingStore(host.probe)

    store.subscribe(() => {})

    host.emit({ hidden: true, room: false })

    expect(store.read()).toBe(true)

    host.emit({ hidden: false })

    expect(store.read()).toBe(false)
  })

  it('答案没变就不通知：useSyncExternalStore 靠这条免于重渲', () => {
    const host = fakeHost({ room: true })
    const store = createDockingStore(host.probe)
    let notified = 0

    store.subscribe(() => {
      notified += 1
    })

    host.emit({ room: true })

    expect(notified).toBe(0)

    host.emit({ room: false })

    expect(notified).toBe(1)
  })
})
