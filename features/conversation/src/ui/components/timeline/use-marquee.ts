import { useEffect, useRef } from 'react'
import {
  clampToTail,
  isSettled,
  type MarqueeGeometry,
  type MarqueeState,
  RATE_WINDOW_MS,
  type RateSample,
  rateOf,
  step,
  TAIL_EM,
  targetOffset,
} from './marquee-model'

/*
 * 逐帧引擎：唯一碰 requestAnimationFrame 和 ResizeObserver 的地方。
 *
 * **逐帧不进 React**。每 16ms 一次 setState 会让组头这一行在流式期间反复提交，而这一行挂着
 * 虚拟列表的 measureElement —— 提交多了就是滚动补偿抖动。所以这里直接写 style.transform 和
 * data-* 属性：transform 只重绘不重排，也不会反过来引起 ResizeObserver 回调。
 *
 * 量宽用 ResizeObserver 而不是在循环里读 offsetWidth：逐帧读会强制同步布局，一帧一次全页
 * 重排。尾部留白在窗口的 RO 回调里算一次（读一次 fontSize），之后都按像素用。
 *
 * 三种 mode：
 *   • glide —— 思考句：上面那套完整的追随；
 *   • tail  —— 工具行：不动，超宽时右对齐（显示末尾），左端由 CSS 淡出；
 *   • start —— 落定态：不动，从头显示，末尾省略号由 CSS 负责。
 *
 * 后两种挂上就报 settled：它们本来就不需要划，让调度器的规则退化成「至少露面一会儿」。
 */

export type MarqueeMode = 'glide' | 'tail' | 'start'

export interface MarqueeOptions {
  readonly mode: MarqueeMode
  /** 减少动态效果：glide 按 tail 处理（直接显示最新部分） */
  readonly reduced: boolean
  /** 划到位（或不需要划）时调用一次。同一个目标只报一次。 */
  readonly onSettled: () => void
}

export interface MarqueeRefs {
  readonly track: (node: HTMLSpanElement | null) => void
  readonly viewport: (node: HTMLSpanElement | null) => void
  /** 当前轨道元素：墨迹那一层也要用它当子树根（两者挂在同一个节点上）。 */
  readonly node: () => HTMLSpanElement | null
}

/** 挂上元素时量到的尺寸。 */
interface Metrics {
  content: number
  viewport: number
  tail: number
}

/** 首次量到尺寸前不写 DOM：那时 content 与 viewport 都是 0，写了等于把轨道拽回原点。 */
const hasSizes = (m: Metrics): boolean => m.viewport > 0 && m.content > 0

/** 把 transform 写进去。`x` 向左为正，CSS 要的是负号。 */
function paint(node: HTMLSpanElement, x: number, moving: boolean): void {
  node.style.transform = x === 0 ? '' : `translate3d(${String(-x)}px, 0, 0)`
  node.toggleAttribute('data-moving', moving)
}

/** 窗口上那个「已经往左划过」的记号：CSS 靠它决定要不要画左侧淡出。 */
function markScrolled(node: HTMLSpanElement, scrolled: boolean): void {
  node.toggleAttribute('data-scrolled', scrolled)
}

/**
 * 一句话的横向追随。
 *
 * 返回两个 ref 回调（轨道、窗口）。两个元素都由 MarqueeTrack 渲染 —— 换句时整棵子树跟着
 * 那一句一起退场，卸载即停止循环，退场中的旧句因此保留退场前的位置与淡出，不再追随。
 */
export function useMarquee(options: MarqueeOptions): MarqueeRefs {
  const { mode, reduced, onSettled } = options
  const trackNode = useRef<HTMLSpanElement | null>(null)
  const viewportNode = useRef<HTMLSpanElement | null>(null)
  const metrics = useRef<Metrics>({ content: 0, viewport: 0, tail: 0 })
  const samples = useRef<RateSample[]>([])
  const state = useRef<MarqueeState>({ x: 0, v: 0 })
  const frame = useRef<number | null>(null)
  const lastFrameAt = useRef(0)
  const measured = useRef(false)
  const reportedAt = useRef<number | null>(null)
  /** 回调经 ref 转一手：逐帧循环闭包拿到的永远是最后一次渲染的那份。 */
  const settle = useRef(onSettled)

  settle.current = onSettled

  useEffect(() => {
    const track = trackNode.current
    const viewport = viewportNode.current

    if (track === null || viewport === null) return undefined

    /* 不动的那两种：直接摆到位、报一次到位，一个观察者都不需要。 */
    if (mode !== 'glide' || reduced) {
      const still: MarqueeState = { x: 0, v: 0 }

      metrics.current = { content: 0, viewport: 1, tail: 0 }
      state.current = still
      paint(track, 0, false)
      markScrolled(viewport, mode === 'tail')
      settle.current()

      return undefined
    }

    const stop = (): void => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }

    const geometry = (): MarqueeGeometry => ({
      content: metrics.current.content,
      viewport: metrics.current.viewport,
      tail: metrics.current.tail,
    })

    const loop = (now: number): void => {
      frame.current = null

      const dt = now - lastFrameAt.current

      lastFrameAt.current = now
      samples.current = samples.current.filter((sample) => now - sample.at <= RATE_WINDOW_MS)

      const g = geometry()
      const target = targetOffset(g)
      const rate = rateOf(samples.current, now)
      const next = step(state.current, target, rate, dt, g)
      const x = clampToTail(next.x, target, g.tail)

      state.current = { x, v: next.v }
      paint(track, x, x > 0.5)
      markScrolled(viewport, x > 0.5)

      if (isSettled(state.current, target)) {
        /* 钉到目标上：逐帧余下那点零头会在视觉上留一个小缝。 */
        state.current = { x: target, v: 0 }
        paint(track, target, false)
        markScrolled(viewport, target > 0.5)

        if (reportedAt.current !== target) {
          reportedAt.current = target
          settle.current()
        }

        return
      }

      frame.current = requestAnimationFrame(loop)
    }

    const kick = (): void => {
      if (frame.current === null) {
        lastFrameAt.current = performance.now()
        frame.current = requestAnimationFrame(loop)
      }
    }

    /**
     * 尺寸变了：重算目标、记样本、**当场**把底线写进 DOM，再决定要不要开循环。
     *
     * 当场写那一下是必要的：RO 回调在布局之后、绘制之前送达，新字出现的那一帧因此就越不过
     * 右边缘。只靠逐帧循环的话，那一帧已经画出去了。
     */
    const sync = (): void => {
      const g = geometry()

      if (!hasSizes(metrics.current)) return

      const target = targetOffset(g)
      const now = performance.now()

      samples.current.push({ at: now, target })
      samples.current = samples.current.filter((sample) => now - sample.at <= RATE_WINDOW_MS)

      /*
       * 首次量到尺寸（含虚拟列表滚出再滚回来时重新挂载）：直接到位，不从 0 滑起 ——
       * 行刚出现就自己演一遍划动，读起来像重播。
       */
      if (!measured.current) {
        measured.current = true
        state.current = { x: target, v: 0 }
        paint(track, target, false)
        markScrolled(viewport, target > 0.5)

        return
      }

      const x = clampToTail(state.current.x, target, g.tail)

      if (x !== state.current.x) {
        state.current = { x, v: state.current.v }
        paint(track, x, x > 0.5)
        markScrolled(viewport, x > 0.5)
      }

      kick()
    }

    const content = new ResizeObserver(sync)
    const box = new ResizeObserver((entries) => {
      const entry = entries[0]

      metrics.current.viewport = entry?.borderBoxSize[0]?.inlineSize ?? entry?.contentRect.width ?? 0
      /* 尾部留白按像素钉住：逐帧读 fontSize 会强制布局。 */
      metrics.current.tail = Number.parseFloat(getComputedStyle(viewport).fontSize) * TAIL_EM

      if (entry !== undefined) {
        metrics.current.content = track.getBoundingClientRect().width
      }

      sync()
    })

    content.observe(track)
    box.observe(viewport)

    /* 首帧那两个观察者要等下一次布局才回调；先手工量一次，行出现时就已经摆好。 */
    metrics.current = {
      content: track.getBoundingClientRect().width,
      viewport: viewport.getBoundingClientRect().width,
      tail: Number.parseFloat(getComputedStyle(viewport).fontSize) * TAIL_EM,
    }

    if (hasSizes(metrics.current)) sync()

    return () => {
      stop()
      content.disconnect()
      box.disconnect()
    }
  }, [mode, reduced])

  return {
    track: (node) => {
      trackNode.current = node
    },
    viewport: (node) => {
      viewportNode.current = node
    },
    node: () => trackNode.current,
  }
}
