import { useEffect, useId, useSyncExternalStore } from 'react'
import { SECOND } from '../semantics/duration'
import { createExternalStore } from './external-store'

/*
 * 到期唤醒：消费者报出这一屏的期限，时钟睡到那一刻为止。不在渲染时读 Date.now()（标签只在别处状态碰巧变化时才刷新），也不轮询
 * （太慢则文案最坏晚一整个周期，太快则绝大多数次醒来输出与上一帧逐字相同）。now 只在 fire() 里换一次，getSnapshot 必须纯读。
 */

/** 期限已过或算错时的兜底：宁可晚一点，也不要退化成忙等。 */
const FLOOR = 250

/** 单次等待上限：兜住 setTimeout 的 32 位截断与休眠期间的时钟跳变。 */
const CEILING = 86_400_000

const view = typeof document === 'undefined' ? undefined : document

/** 各消费者的期限；是个时刻，所以依赖数组管得住它。 */
const horizons = new Map<string, number>()

let now = Date.now()
let live = false
let timer: ReturnType<typeof setTimeout> | undefined
let scheduledFor = Number.POSITIVE_INFINITY
let pending = false

const clock = createExternalStore<number>({
  read: () => now,
  activate: () => {
    live = true
    view?.addEventListener('visibilitychange', resync)
    plan()

    return () => {
      live = false
      view?.removeEventListener('visibilitychange', resync)
      plan()
    }
  },
})

function awake(): boolean {
  return view === undefined || view.visibilityState === 'visible'
}

/** 最早会发生变化的时刻；没人关心时是 Infinity，不排表。 */
function soonest(): number {
  if (!live || !awake()) {
    return Number.POSITIVE_INFINITY
  }

  let found = Number.POSITIVE_INFINITY

  for (const at of horizons.values()) {
    if (Number.isFinite(at) && at < found) {
      found = at
    }
  }

  return found
}

/*
 * 期限要等全体消费者都报完才算得准，所以不能「每报一次就结算一次」：一次跳动会让每个消费者重画、每次重画都重报，C 个消费者要走 C+1 遍。
 */
function plan(): void {
  if (pending) {
    return
  }

  pending = true
  queueMicrotask(settle)
}

function settle(): void {
  pending = false

  const at = soonest()

  if (at === scheduledFor) {
    return
  }

  scheduledFor = at

  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }

  if (at === Number.POSITIVE_INFINITY) {
    return
  }

  timer = setTimeout(fire, Math.min(Math.max(at - Date.now(), FLOOR), CEILING))
}

function fire(): void {
  timer = undefined
  scheduledFor = Number.POSITIVE_INFINITY
  now = Date.now()

  clock.notify()

  plan()
}

/** 窗口重新可见时先补一帧，再重新排表：后台期间不烧 CPU，回来不落后。 */
function resync(): void {
  if (awake()) {
    fire()
  } else {
    plan()
  }
}

/** 当前时刻。订阅这口时钟，它跳一次这一屏重画一次。 */
export function useNow(): number {
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read)
}

/**
 * 期限要等这一帧的投影做完才算得出来，而投影要先拿到 now。key 用 useId 而不是列表的 key —— 要的就是「这个实例」本身。
 */
export function useHorizon(at: number): void {
  const key = useId()

  useEffect(() => {
    horizons.set(key, at)
    plan()

    return () => {
      horizons.delete(key)
      plan()
    }
  }, [at, key])
}

/** 秒表也走这一口时钟；ticking 为假时不报期限，时钟不会为它醒来。 */
export function useSecond(ticking: boolean): number {
  const now = useNow()

  useHorizon(ticking ? now + SECOND : Number.POSITIVE_INFINITY)

  return now
}
