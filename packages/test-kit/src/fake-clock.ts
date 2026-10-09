import { type Clock, type Disposable, toDisposable } from '@poietica/foundation'

export interface FakeClock extends Clock {
  /** 前进 ms 毫秒，按到期顺序同步执行到期的定时器（定时器里新建的、在窗口内到期的也会执行） */
  advance(ms: number): void
  /** 同 advance，但每执行一个定时器后让出一次微任务队列，使 Promise 链有机会推进 */
  advanceAsync(ms: number): Promise<void>
  /** 执行全部待执行的定时器（间隔定时器不算，避免死循环） */
  runAllTimeouts(): void
  /** 尚未执行或取消的定时器个数（含间隔定时器） */
  pendingTimers(): number
}

interface Timer {
  readonly id: number
  due: number
  readonly fn: () => void
  readonly interval: number | null
}

export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let now = start
  let nextId = 1
  const timers = new Map<number, Timer>()

  const add = (fn: () => void, ms: number, interval: number | null): Disposable => {
    const id = nextId++
    timers.set(id, { id, due: now + Math.max(0, ms), fn, interval })
    return toDisposable(() => {
      timers.delete(id)
    })
  }

  /** 取出 limit 之前最早到期的定时器（同一时刻按创建顺序） */
  const nextDue = (limit: number): Timer | undefined => {
    let best: Timer | undefined
    for (const t of timers.values()) {
      if (t.due > limit) continue
      if (best === undefined || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t
    }
    return best
  }

  const fire = (t: Timer): void => {
    now = Math.max(now, t.due)
    if (t.interval === null) timers.delete(t.id)
    else t.due += Math.max(1, t.interval)
    t.fn()
  }

  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, null),
    setInterval: (fn, ms) => add(fn, ms, ms),
    advance(ms) {
      const target = now + ms
      for (let t = nextDue(target); t !== undefined; t = nextDue(target)) fire(t)
      now = target
    },
    async advanceAsync(ms) {
      const target = now + ms
      await Promise.resolve()
      for (let t = nextDue(target); t !== undefined; t = nextDue(target)) {
        fire(t)
        await Promise.resolve()
        await Promise.resolve()
      }
      now = target
    },
    runAllTimeouts() {
      for (;;) {
        let best: Timer | undefined
        for (const t of timers.values()) {
          if (t.interval !== null) continue
          if (best === undefined || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t
        }
        if (best === undefined) return
        fire(best)
      }
    },
    pendingTimers: () => timers.size,
  }
}
