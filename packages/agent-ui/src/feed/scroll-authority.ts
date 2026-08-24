import { useReducedMotion } from 'motion/react'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { startGlide } from '../primitives/scroll-glide'

/** 距末端多近算「在末端」。约一格滚轮，所以人滚回底部附近就重新接管。 */
const NEAR_END_PX = 48

/** 任何滚动高度都到不了的值：CSSOM View 规定 scrollTop 的 setter 把它夹回末端。 */
const BEYOND_END = 2 ** 30

/**
 * 只可能由人产生的事件。
 *
 * scroll 不在此列：程序化写入同样派发它，而滚动事件一帧只派发一次 —— 同一帧里自己那一笔
 * 与人那一拨会合并成一个事件，事后分辨不出。所以意图只从输入设备取，不从几何反推。
 */
const HUMAN_EVENTS: readonly string[] = ['wheel', 'touchstart', 'keydown', 'pointerdown']

/** 人主动展开或收起一段内容的标准声明（WAI-ARIA）。 */
const DISCLOSURE = '[aria-expanded]'

interface Geometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/** 一次读三个量：分三次读会读到三帧之间的布局，而这三个数必须互相自洽。 */
function seen(element: HTMLElement): Geometry {
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }
}

function atEnd(geometry: Geometry): boolean {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop <= NEAR_END_PX
}

/** 视口该在哪。三种，互斥。 */
type Intent =
  | { readonly kind: 'tail' }
  | { readonly kind: 'held'; readonly key: string | null; readonly offset: number }
  | { readonly kind: 'glide'; readonly to: number | null }

const TAIL: Intent = { kind: 'tail' }

/** 按住了，但还不知道按住哪一行：不写，比按到一个猜出来的行上好。 */
const LOOSE: Intent = { kind: 'held', key: null, offset: 0 }

/** 提交那一刻的行几何。由铺内容的那一层交来，所以这一层不认识虚拟器。 */
export interface RowGeometry {
  /** 视口顶端那一行的身份，与它的顶边离视口顶边多远。 */
  readonly top: () => { readonly key: string; readonly offset: number } | null
  /** 这一行现在的偏移；不在表里返回 null。 */
  readonly offsetOf: (key: string) => number | null
  /** 这一行顶边贴齐视口顶边的落点；不在表里返回 null。 */
  readonly offsetOfRow: (row: number) => number | null
}

export interface ScrollAuthority {
  /** 视口此刻是否在末端。几何，不是意图 —— 它只喂那枚「回到最新」的按钮。 */
  readonly atLatest: boolean
  /** 正在去的那一行；没有则为 null。跳转期间缩略导航的高亮真源。 */
  readonly revealing: number | null
  /** 每次提交调用一次。scrollTop 只在这里被写。 */
  readonly settle: (rows: RowGeometry) => void
  /** 开场或换对话：瞬时落到末端。 */
  readonly resume: () => void
  /** 人亲手要求回到末端：一段看得见的位移。 */
  readonly travel: () => void
  /** 人要求去看某一行。 */
  readonly reveal: (row: number) => void
  readonly watch: (viewport: HTMLElement) => () => void
}

/**
 * 滚动位置的唯一所有者。
 *
 * 意图有且只有三种，只由两类事情改变：人的输入设备事件，以及人下的明确命令（回到末端、
 * 去看某一行）。几何只回答一个问题 —— 在不在末端 —— 那个答案只喂一枚按钮，不参与决策。
 *
 * 于是不再需要「刚才那一笔是不是我写的」这种标记：它要correlate一次写入与一个可能被合并、
 * 可能根本不到的事件，而滚动事件一帧只发一次，人的手势与自己的贴合落在同一帧时无从分辨。
 * 按住某一行的做法把这件事变成不必要：锚随人的滚动更新，位置随每次提交恢复，布局抖动因此
 * 一个像素都改不了人的落点。
 *
 * 位移与瞬时落位是两条入口、一条管线（scroll-glide）：终点每帧重读，取消由意图变化终止。
 */
export function useScrollAuthority(): ScrollAuthority {
  const element = useRef<HTMLElement | null>(null)
  const rows = useRef<RowGeometry | null>(null)
  const reduced = useReducedMotion()

  /* 开场跟着末端：一个盒子刚挂上时该看见最新内容。 */
  const intent = useRef<Intent>(TAIL)
  const stopGlide = useRef<(() => void) | null>(null)

  const latest = useRef(true)
  const going = useRef<number | null>(null)
  const listeners = useRef(new Set<() => void>())

  const subscribe = useCallback((onChange: () => void) => {
    listeners.current.add(onChange)

    return () => {
      listeners.current.delete(onChange)
    }
  }, [])

  const readLatest = useCallback(() => latest.current, [])
  const readGoing = useCallback(() => going.current, [])

  const notify = useCallback(() => {
    for (const listener of listeners.current) {
      listener()
    }
  }, [])

  const publish = useCallback(
    (box: HTMLElement) => {
      const now = atEnd(seen(box))

      if (latest.current !== now) {
        latest.current = now
        notify()
      }
    },
    [notify],
  )

  const stop = useCallback(() => {
    stopGlide.current?.()
    stopGlide.current = null
  }, [])

  /** 意图换一次，发布一次。「正在去哪一行」是意图的一个侧面，所以只在这里改。 */
  const aim = useCallback(
    (next: Intent) => {
      intent.current = next

      const row = next.kind === 'glide' ? next.to : null

      if (going.current !== row) {
        going.current = row
        notify()
      }
    },
    [notify],
  )

  /** 按住眼前这一行。 */
  const hold = useCallback(() => {
    const top = rows.current?.top() ?? null

    aim(top === null ? LOOSE : { kind: 'held', key: top.key, offset: top.offset })
  }, [aim])

  const settle = useCallback(
    (next: RowGeometry) => {
      rows.current = next

      const box = element.current

      if (box === null) {
        return
      }

      const current = intent.current

      if (current.kind === 'tail') {
        box.scrollTop = BEYOND_END
      } else if (current.kind === 'held' && current.key !== null) {
        const at = next.offsetOf(current.key)

        if (at !== null) {
          box.scrollTop = at - current.offset
        }
      }

      publish(box)
    },
    [publish],
  )

  const resume = useCallback(() => {
    stop()
    aim(TAIL)

    const box = element.current

    if (box === null) {
      return
    }

    box.scrollTop = BEYOND_END
    publish(box)
  }, [aim, publish, stop])

  /** 一段看得见的位移。终点每帧重读：内容边写边长时它在动。 */
  const glide = useCallback(
    (to: number | null) => {
      const box = element.current

      if (box === null) {
        return
      }

      stop()

      const reach = () =>
        to === null ? box.scrollHeight - box.clientHeight : (rows.current?.offsetOfRow(to) ?? null)

      const arrived = () => {
        if (to === null) {
          aim(TAIL)
        } else {
          hold()
        }

        publish(box)
      }

      /* 没有距离可走，或者这个人要求少一些动效：直接落位。 */
      if (reduced === true || (to === null && atEnd(seen(box)))) {
        const at = reach()

        if (at !== null) {
          box.scrollTop = at
        }

        arrived()

        return
      }

      aim({ kind: 'glide', to })

      stopGlide.current = startGlide(box, {
        arrive: arrived,
        proceed: () => {
          const current = intent.current

          return element.current !== null && current.kind === 'glide' && current.to === to
        },
        target: reach,
      })
    },
    [aim, hold, publish, reduced, stop],
  )

  const travel = useCallback(() => {
    glide(null)
  }, [glide])

  const reveal = useCallback(
    (row: number) => {
      glide(row)
    },
    [glide],
  )

  const watch = useCallback(
    (box: HTMLElement) => {
      element.current = box
      publish(box)

      /* 人一动手就按住眼前这一行。展开与收起同样是他的手，所以走同一条路。 */
      const onHuman = () => {
        stop()
        hold()
      }

      const onToggle = (event: Event) => {
        const target = event.target

        if (target instanceof Element && target.closest(DISCLOSURE) !== null) {
          onHuman()
        }
      }

      /* 锚随人走：滚动期间顶行在换，按住的那一行必须跟着换。滚动不改意图。 */
      const onScroll = () => {
        if (intent.current.kind === 'held') {
          hold()
        }

        publish(box)
      }

      /* 重新上闩只有这一处：一段滚动停下来，而视口停在末端。 */
      const onScrollEnd = () => {
        if (intent.current.kind === 'held' && atEnd(seen(box))) {
          aim(TAIL)
        }
      }

      for (const name of HUMAN_EVENTS) {
        box.addEventListener(name, onHuman, { passive: true })
      }

      box.addEventListener('click', onToggle)
      box.addEventListener('scroll', onScroll, { passive: true })
      box.addEventListener('scrollend', onScrollEnd)

      return () => {
        stop()

        for (const name of HUMAN_EVENTS) {
          box.removeEventListener(name, onHuman)
        }

        box.removeEventListener('click', onToggle)
        box.removeEventListener('scroll', onScroll)
        box.removeEventListener('scrollend', onScrollEnd)
        element.current = null
      }
    },
    [aim, hold, publish, stop],
  )

  return {
    atLatest: useSyncExternalStore(subscribe, readLatest),
    revealing: useSyncExternalStore(subscribe, readGoing),
    reveal,
    resume,
    settle,
    travel,
    watch,
  }
}
