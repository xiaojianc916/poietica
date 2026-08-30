import { createExternalStore } from '@poietica/external-store'
import { useEffect, useId, useSyncExternalStore } from 'react'

/*
 * 会话时间的唯一管线：一口时钟、一套文案、一套分段。
 *
 * 时间标签是随墙上时间变化的量，所以它必须由时钟驱动，不能在渲染时读一次
 * Date.now() —— 那样的标签只在别处状态碰巧变化时才刷新，看上去就是「莫名
 * 其妙老是改动」，中间几十分钟一动不动。
 *
 * 时钟不轮询。轮询周期是一个猜测，而且两头都错：它太慢（边界与周期不同相，
 * 文案最坏晚一整个周期才变），又太快（绝大多数次醒来，输出与上一帧逐字相
 * 同）。而「下一次文案会变的时刻」是可以由那道阶梯反推出来的已知量，所以
 * 这里是到期唤醒：消费者报出这一屏的期限，时钟睡到那一刻为止。GitHub 的
 * <relative-time>、Apple 的 Text(style: .relative)、Android 的 TextClock
 * 都是这么做的，没有一个是定周期轮询。
 *
 * 订阅那圈样板不在这个文件里：它是每个 React 外部数据源都要写一遍的东西，
 * 住在 @poietica/design-system 的 external-store。这个文件只负责「现在几点」和「下次
 * 几点」。
 *
 * now 只在 fire() 里换一次。getSnapshot 必须是纯读，这是 useSyncExternalStore
 * 的前提 —— 在 subscribe() 里写它就是 React 的 effect 阶段，等于让这一帧用旧值
 * 渲染完之后再把快照换掉。
 */

/** 期限已经过去或算错时的兜底间隔：宁可晚一点，也不要退化成忙等。 */
const FLOOR = 250

/** 单次等待的上限：兜住 setTimeout 的 32 位截断，也兜住休眠期间的时钟跳变。 */
const CEILING = 86_400_000

/** 秒表的一拍。 */
const SECOND = 1_000

const view = typeof document === 'undefined' ? undefined : document

/** 各消费者的期限，一个时刻 —— 可比较，所以依赖数组管得住它。 */
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

/** 这一刻起，最早会发生变化的时刻；没有人关心时是 Infinity，也就不排表。 */
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
 * 排表分两半：plan() 只标记「待排」，真正的结算在微任务里做一次。
 *
 * 期限只有在全体消费者都报完之后才算得准，所以「每报一次就结算一次」这个
 * 形状本身是错的：一次跳动会让每个消费者重画，每次重画都要重报期限，于是
 * C 个消费者要走 C+1 遍 soonest()。标记脏、批内合并、边界结算一次，是调度
 * 器的通行结构。微任务一定早于任何 setTimeout，所以合批不推迟唤醒。
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

/** 当前时刻。订阅这口时钟，它跳一次，这一屏就重画一次。 */
export function useNow(): number {
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read)
}

/**
 * 报出「这一屏下一次会变的时刻」，时钟睡到那一刻为止。
 *
 * 与 useNow 分开，不是为了拆得细，是因为期限算得出来的前提是这一帧的投影已经
 * 做完，而投影要先拿到 now。分成两步，顺序就是渲染本身的顺序：取时刻、做投影、
 * 报期限。期限是个数，所以依赖数组管得住它：同一个期限重报多少次都不排表。
 *
 * 「哪一个消费者」用 useId：每个调用点每个实例一个稳定唯一的标识，一次分配都
 * 不做。这不是列表的 key（官方明确劝阻的那种用法）—— 这里要的恰恰是「这个实例」
 * 本身，与数据无关。
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

/**
 * 一秒一拍。
 *
 * 秒表也是墙上时间，所以它走这一口时钟：ticking 为假时不报期限，时钟不会为它
 * 醒来；页签不可见时整口时钟停摆，回到前台补一帧再排表。
 */
export function useSecond(ticking: boolean): number {
  const now = useNow()

  useHorizon(ticking ? now + SECOND : Number.POSITIVE_INFINITY)

  return now
}
