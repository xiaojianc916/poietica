import { type Clock, type Disposable, systemClock } from '@poietica/foundation'

/*
 * 什么时候换句。只看时间，不和逐帧那一层握手：换句时刻 = max(这一句露面满 MIN_DWELL_MS, 下一句出现后 FINISH_MS)。
 * 第一个等待者出现时算一次、定一个计时器，之后不再后推：两边各有一条规则时「到位」永远不成立，每次换句都要等满上限。
 */

export interface LineSnapshot {
  readonly key: string
  readonly text: string
}

export interface Promotion {
  readonly snapshot: LineSnapshot
  /** 等待期间跳过了至少一句：用快速刷 */
  readonly fast: boolean
}

export const ROLL_MS = 260
export const FAST_ROLL_MS = 140

/** 一句话至少露面这么久才会被刷走：再短就读不完一眼。 */
export const MIN_DWELL_MS = 700

/** 下一句出现后至少等这么久：给旧句把缓冲里的字写完。 */
export const FINISH_MS = 220

export interface RollScheduler {
  /** 每次渲染都喂：同 key 是原地更新，异 key 是下一句。 */
  offer(next: LineSnapshot, previous: LineSnapshot | null): void
  /** 当前显示的那句。 */
  shown(): LineSnapshot
  /** 是否有下一句在等（容器据此让旧句加速收尾）。 */
  waiting(): boolean
  setImmediate(immediate: boolean): void
  /** 订阅换句。没有订阅者时不定时（提升了也没人重渲染）。 */
  onPromote(listener: (promotion: Promotion) => void): Disposable
  /** 清掉计时器与监听者。之后重新订阅仍可继续用（StrictMode 的模拟卸载会这样做）。 */
  dispose(): void
}

export function promoteAt(shownAt: number, firstWaitingAt: number): number {
  return Math.max(shownAt + MIN_DWELL_MS, firstWaitingAt + FINISH_MS)
}

export function createRollScheduler(
  initial: LineSnapshot,
  clock: Clock = systemClock,
  immediate = false,
): RollScheduler {
  let shown = initial
  let shownAt = clock.now()
  let pending: LineSnapshot | null = null
  /** 第一个等待者出现的时刻：换句时刻由它和 shownAt 算出，之后来的句子不改它。 */
  let waitingSince = 0
  let skipped = 0
  let timer: Disposable | null = null
  let instant = immediate
  const listeners = new Set<(promotion: Promotion) => void>()

  const clearTimer = (): void => {
    timer?.dispose()
    timer = null
  }

  const promote = (): void => {
    clearTimer()

    if (pending === null) return

    const promotion: Promotion = { snapshot: pending, fast: skipped > 0 }

    shown = pending
    shownAt = clock.now()
    pending = null
    skipped = 0
    for (const listener of listeners) listener(promotion)
  }

  /*
   * 没人在听时不定时：提升了也没人重渲染，画面会停在旧句上；重新订阅时在这里补上 —— 用的还是原来的 waitingSince。
   */
  const arm = (): void => {
    if (pending === null || timer !== null || listeners.size === 0) return

    const now = clock.now()

    timer = clock.setTimeout(promote, Math.max(0, promoteAt(shownAt, waitingSince) - now))
  }

  /* 旧句收尾：同一批 token 里旧句的最后几个字还没落进 shown，用 previous 补完；只许变长。 */
  const complete = (previous: LineSnapshot | null): void => {
    if (previous !== null && previous.key === shown.key && previous.text.length > shown.text.length) shown = previous
  }

  const queue = (next: LineSnapshot): void => {
    if (pending === null) waitingSince = clock.now()
    else if (pending.key !== next.key) skipped += 1

    pending = next

    if (instant) promote()
    else arm()
  }

  return {
    offer(next, previous) {
      if (next.key === shown.key) {
        shown = next
        return
      }

      complete(previous)
      queue(next)
    },
    shown: () => shown,
    waiting: () => pending !== null,
    setImmediate(value) {
      instant = value
      if (instant && pending !== null) promote()
    },
    onPromote(listener) {
      listeners.add(listener)
      arm()

      return {
        dispose: () => {
          listeners.delete(listener)
          if (listeners.size === 0) clearTimer()
        },
      }
    },
    dispose() {
      /* 计时器与监听者一并清掉。不标成「已死」：StrictMode 会模拟一次卸载再挂回同一实例，标死了那一格就再也不换句。 */
      clearTimer()
      listeners.clear()
    },
  }
}
