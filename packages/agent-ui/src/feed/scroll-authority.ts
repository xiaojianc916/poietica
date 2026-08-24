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
 * scroll 不在此列：程序化写入同样派发它，而滚动事件一帧只发一次 —— 同一帧里自己那一笔
 * 与人那一拨合并成一个事件，事后分辨不出。
 */
const HUMAN_EVENTS: readonly string[] = ['wheel', 'touchstart', 'keydown', 'pointerdown']

/** 人主动展开或收起一段内容的标准声明（WAI-ARIA）。 */
const DISCLOSURE = '[aria-expanded]'

/**
 * 一次前插最多纠这么多帧。
 *
 * 补进来那一页的行还是估高，一次写入按不住落点；而前插是有界的事件，不是每帧都在发生
 * 的事，所以帧数写死在这里，人一动手当场作废。
 */
const PIN_FRAMES = 12

/** 落点差不到这么多就算按住了。 */
const PIN_EPSILON_PX = 0.5

/** 一次滚动几何读数。字段名与 Element 对齐，所以可以直接从元素上抄。 */
export interface ScrollGeometry {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/** 视口该在哪。三种，互斥。 */
export type Intent = 'tail' | 'free' | 'glide'

/** 一次读三个量：分三次读会读到三帧之间的布局，而这三个数必须互相自洽。 */
function seen(element: HTMLElement): ScrollGeometry {
  return {
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }
}

/** 这个几何算不算「视口在末端」。 */
export function atEnd(geometry: ScrollGeometry): boolean {
  return geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop <= NEAR_END_PX
}

/**
 * 内容长高了要不要把视口带走。
 *
 * 水位线必须真的变大。每次提交都拨一次，写下的是上一次采样时的位置，而人的手势在两次
 * 采样之间还在走 —— 那一笔把他按回去，两个方向都成锯齿。
 */
export function followsGrowth(intent: Intent, mark: number, marked: number): boolean {
  return intent === 'tail' && mark > marked
}

/** 一段滚动停下来之后的意图。停在末端才重新上闩；位移途中谁都不许收。 */
export function intentAtRest(intent: Intent, geometry: ScrollGeometry): Intent {
  return intent === 'free' && atEnd(geometry) ? 'tail' : intent
}

/** 按住那一行还差多少；null 表示已经按住。 */
export function pinDelta(current: number, target: number): number | null {
  const delta = target - current

  return Math.abs(delta) <= PIN_EPSILON_PX ? null : delta
}

/** 视口顶端那一行，与它的顶边离视口顶边多远。 */
export interface RowAnchor {
  readonly key: string
  readonly offset: number
}

/** 行几何。身份与行号进、像素出：持有位置的这一层因此不认识虚拟器。 */
export interface RowGeometry {
  readonly offsetOf: (key: string) => number | null
  readonly offsetOfRow: (row: number) => number | null
}

export interface ScrollAuthority {
  /** 视口此刻是否在末端。几何，不是意图 —— 它只喂那枚「回到最新」的按钮。 */
  readonly atLatest: boolean
  /** 正在去的那一行；没有则为 null。跳转期间缩略导航的高亮真源。 */
  readonly revealing: number | null
  /** 还跟着末端吗。虚拟器的补偿判据要问它，所以是函数而不是渲染值。 */
  readonly following: () => boolean
  /** 每次提交交出行几何。只存引用，一个 scrollTop 都不写。 */
  readonly track: (rows: RowGeometry) => void
  /** 视线扫过时记下顶行：前插要按回原处的就是它。 */
  readonly mark: (anchor: RowAnchor | null) => void
  /** 内容水位线。真的长高、且还跟着末端时才拨一次。 */
  readonly follow: (mark: number) => void
  /** 往前补了一页：把记下的那一行按回原处。有界，人一动手就作废。 */
  readonly pin: () => void
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
 * 写入只发生在四种转变上，没有一种是「又提交了一次」：内容长高（follow）、往前补了一页
 * （pin）、开场或换对话（resume）、人下了一个有目的地的指令（travel / reveal）。铺内容的
 * 那一层因此一个 scrollTop 都不写。
 *
 * 估高被真高替换那一类补偿不在这里：虚拟器是唯一知道哪一行刚被重测的，判据由持有它的那
 * 一层用官方的 shouldAdjustScrollPositionOnItemSizeChange 交出去。
 *
 * 意图只由人的输入设备事件与人的明确命令改变。几何只回答「在不在末端」，那个答案只喂一
 * 枚按钮，不参与决策。
 */
export function useScrollAuthority(): ScrollAuthority {
  const element = useRef<HTMLElement | null>(null)
  const rows = useRef<RowGeometry | null>(null)
  const anchor = useRef<RowAnchor | null>(null)
  const reduced = useReducedMotion()

  /* 开场跟着末端：一个盒子刚挂上时该看见最新内容。 */
  const intent = useRef<Intent>('tail')
  const stopGlide = useRef<(() => void) | null>(null)
  const stopPin = useRef<(() => void) | null>(null)

  /* 内容的水位线。-1 表示还没收到过一份内容，所以第一份必然算「长高了」。 */
  const marked = useRef(-1)

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
  const following = useCallback(() => intent.current === 'tail', [])

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

  const halt = useCallback(() => {
    stopGlide.current?.()
    stopGlide.current = null
    stopPin.current?.()
    stopPin.current = null
  }, [])

  /** 意图换一次，发布一次。「正在去哪一行」是意图的一个侧面，所以只在这里改。 */
  const aim = useCallback(
    (next: Intent, row: number | null) => {
      intent.current = next

      if (going.current !== row) {
        going.current = row
        notify()
      }
    },
    [notify],
  )

  const track = useCallback((next: RowGeometry) => {
    rows.current = next
  }, [])

  /* 按住与位移期间不换锚：那时顶行是程序挑的，不是读者挑的。 */
  const mark = useCallback((next: RowAnchor | null) => {
    if (stopPin.current !== null || intent.current === 'glide') {
      return
    }

    anchor.current = next
  }, [])

  const follow = useCallback(
    (height: number) => {
      const grew = followsGrowth(intent.current, height, marked.current)

      marked.current = height

      const box = element.current

      if (!grew || box === null) {
        return
      }

      box.scrollTop = BEYOND_END
      publish(box)
    },
    [publish],
  )

  /**
   * 往前补了一页，眼前那一行不动。
   *
   * 纠到贴齐为止而不是纠一次：补进来的行此刻还是估高，落点会随真实测量继续移动。帧数有
   * 界，人一动手当场作废 —— 那之后滚动位置属于打断它的那个人。
   */
  const pin = useCallback(() => {
    const box = element.current
    const held = anchor.current
    const view = box?.ownerDocument.defaultView ?? null

    if (box === null || held === null || view === null) {
      return
    }

    stopPin.current?.()

    let frames = 0
    let frame = 0

    const step = () => {
      const to = rows.current?.offsetOf(held.key) ?? null
      const delta = to === null ? null : pinDelta(box.scrollTop, to - held.offset)

      if (delta !== null) {
        box.scrollTop += delta
      }

      frames += 1

      if (delta === null || frames >= PIN_FRAMES) {
        stopPin.current = null
        publish(box)

        return
      }

      frame = view.requestAnimationFrame(step)
    }

    frame = view.requestAnimationFrame(step)

    stopPin.current = () => {
      view.cancelAnimationFrame(frame)
      stopPin.current = null
    }
  }, [publish])

  const resume = useCallback(() => {
    halt()
    aim('tail', null)

    /* 换一条对话时内容可能更短：水位线跟着重来，否则长回旧高度之前都不算长高。 */
    marked.current = -1

    const box = element.current

    if (box === null) {
      return
    }

    box.scrollTop = BEYOND_END
    publish(box)
  }, [aim, halt, publish])

  /** 一段看得见的位移。终点每帧重读：内容边写边长时它在动。 */
  const glide = useCallback(
    (to: number | null) => {
      const box = element.current

      if (box === null) {
        return
      }

      halt()

      const reach = () =>
        to === null ? box.scrollHeight - box.clientHeight : (rows.current?.offsetOfRow(to) ?? null)

      const arrived = () => {
        aim(to === null ? 'tail' : 'free', null)
        publish(box)
      }

      /* 没有距离可走，或者这个人要求少一些动效：直接落位。 */
      if (reduced === true || (to === null && atEnd(seen(box)))) {
        const landing = reach()

        if (landing !== null) {
          box.scrollTop = landing
        }

        arrived()

        return
      }

      aim('glide', to)

      stopGlide.current = startGlide(box, {
        arrive: arrived,
        proceed: () =>
          element.current !== null && intent.current === 'glide' && going.current === to,
        target: reach,
      })
    },
    [aim, halt, publish, reduced],
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

      /* 人一动手就让开。展开与收起同样是他的手，所以走同一条路。 */
      const onHuman = () => {
        halt()
        aim('free', null)
      }

      const onToggle = (event: Event) => {
        const target = event.target

        if (target instanceof Element && target.closest(DISCLOSURE) !== null) {
          onHuman()
        }
      }

      const onScroll = () => {
        publish(box)
      }

      /* 重新上闩只有这一处：一段滚动停下来，而视口停在末端。 */
      const onScrollEnd = () => {
        const next = intentAtRest(intent.current, seen(box))

        if (next !== intent.current) {
          aim(next, null)
        }
      }

      for (const name of HUMAN_EVENTS) {
        box.addEventListener(name, onHuman, { passive: true })
      }

      box.addEventListener('click', onToggle)
      box.addEventListener('scroll', onScroll, { passive: true })
      box.addEventListener('scrollend', onScrollEnd)

      return () => {
        halt()

        for (const name of HUMAN_EVENTS) {
          box.removeEventListener(name, onHuman)
        }

        box.removeEventListener('click', onToggle)
        box.removeEventListener('scroll', onScroll)
        box.removeEventListener('scrollend', onScrollEnd)
        element.current = null
      }
    },
    [aim, halt, publish],
  )

  return {
    atLatest: useSyncExternalStore(subscribe, readLatest),
    revealing: useSyncExternalStore(subscribe, readGoing),
    follow,
    following,
    mark,
    pin,
    resume,
    reveal,
    track,
    travel,
    watch,
  }
}
