import { type Clock, type Disposable, systemClock } from '@poietica/foundation'

/*
 * 什么时候换句。
 *
 * 换句要等旧句「说完」：划到句尾、到位、再停一下 —— 否则人刚看到句尾就被刷走。
 * 但不能无限等：快模型一秒能写好几句，等下去组头就永远落后。所以：
 * 旧句至少露面 MIN_VISIBLE_MS；到位后再停 END_HOLD_MS；新句最多等 MAX_WAIT_MS。
 * 等待期间又来了更新的句子，就把等待的那句换掉（过期的不补播），并用快速刷。
 *
 * 「已经到位」这件事只有逐帧那一层知道，所以要由 MarqueeTrack 回报（settled）。工具行与
 * 落定态一挂上就报，于是规则自然退化为「至少露面 450ms」—— 它们本来就不动。
 *
 * 这里不碰 DOM、不碰 React：clock 是注入的，测试用 fakeClock 推着走（见 __tests__）。
 */

export interface LineSnapshot {
  readonly key: string
  readonly text: string
}

export interface Promotion {
  readonly snapshot: LineSnapshot
  /** 期间跳过了至少一句（或撞上了等待上限），用快速刷 */
  readonly fast: boolean
}

/** 正常 / 积压时的上下刷时长。 */
export const ROLL_MS = 260
export const FAST_ROLL_MS = 140

/** 一句话至少停留这么久才允许被刷走。 */
export const MIN_VISIBLE_MS = 450

/** 句子划到句尾、到位之后再停这么久。 */
export const END_HOLD_MS = 250

/** 新句最多等这么久；超时就打断旧句的划动，直接换。 */
export const MAX_WAIT_MS = 1200

export interface RollScheduler {
  /** 每次渲染都喂：同 key 是原地更新，异 key 是新句。 */
  offer(next: LineSnapshot, previous: LineSnapshot | null): void
  /** MarqueeTrack 报告当前句已划到位（或不需要划）。 */
  settled(key: string): void
  /** 当前显示的那句（容器渲染它）。 */
  shown(): LineSnapshot
  onPromote(listener: (promotion: Promotion) => void): Disposable
  dispose(): void
}

/**
 * @param initial 第一句（容器挂上时手上已有的内容）
 * @param clock 计时用的时钟
 * @param immediate 减少动态效果：新句直接换，不等任何条件
 */
export function createRollScheduler(
  initial: LineSnapshot,
  clock: Clock = systemClock,
  immediate = false,
): RollScheduler {
  let shown = initial
  let shownAt = clock.now()
  let settledAt: number | null = null
  let pending: LineSnapshot | null = null
  let pendingSince = 0
  let skipped = 0
  let timer: Disposable | null = null
  let disposed = false
  const listeners = new Set<(promotion: Promotion) => void>()

  const clearTimer = (): void => {
    timer?.dispose()
    timer = null
  }

  const promote = (fast: boolean): void => {
    if (pending === null) return

    shown = pending
    shownAt = clock.now()
    settledAt = null
    pending = null
    skipped = 0
    clearTimer()

    for (const listener of listeners) listener({ snapshot: shown, fast })
  }

  const evaluate = (): void => {
    if (disposed || pending === null) return

    const now = clock.now()
    const ready = Math.max(
      shownAt + MIN_VISIBLE_MS,
      settledAt === null ? Number.POSITIVE_INFINITY : settledAt + END_HOLD_MS,
    )
    const deadline = pendingSince + MAX_WAIT_MS
    const at = Math.min(ready, deadline)

    if (at <= now) {
      promote(skipped > 0 || at === deadline)
      return
    }

    clearTimer()
    timer = clock.setTimeout(evaluate, at - now)
  }

  return {
    offer(next, previous) {
      if (disposed) return

      /* 同一句继续写：原地生长，不换句。又有新字了，因此「已经到位」作废。 */
      if (next.key === shown.key) {
        shown = next
        settledAt = null
        return
      }

      /*
       * 同一批 token 里旧句收尾、新句开头：旧句的最后几个字还没落进 shown，用它补完。
       * 不补的话，旧句会一直停在「差最后几个字」的样子上被刷走。
       *
       * 只许往前补，不许往回缩：`previous` 是「那一句现在长什么样」，而 shown 里可能已经
       * 有了比它更多的一次性渲染（同一批里先按新句算过一轮）。取更长的那个，「补完」这个
       * 动作就永远不会把已经印出来的字抹掉。
       */
      if (previous !== null && previous.key === shown.key && previous.text.length > shown.text.length) {
        shown = previous
      }

      if (pending !== null && pending.key !== next.key) skipped += 1

      if (pending === null || pending.key !== next.key) pendingSince = clock.now()

      pending = next

      /* 少动效：新句直接上，不等也不刷。 */
      if (immediate) {
        promote(false)
        return
      }

      evaluate()
    },
    settled(key) {
      if (disposed || key !== shown.key) return

      settledAt = clock.now()
      evaluate()
    },
    shown: () => shown,
    onPromote(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      clearTimer()
      listeners.clear()
    },
  }
}
