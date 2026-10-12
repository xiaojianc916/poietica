/*
 * 新写出的那几个字的「墨迹」：先亮、淡入，随后冷却成这一行的安静色。
 *
 * 做法沿用正文「波浪淡入」的经验（wave-dom.ts）：动画用 Web Animations 挂上，并把 startTime
 * 钉在这段尾巴开始的绝对时刻。React 换掉节点或复用节点时，进度因此从正确的位置接着走，
 * 而不是从头再闪一次 —— 流式里每秒十几次重渲染，每次都从头闪就是一盏一直在闪的灯。
 *
 * 只有一个尾巴 span：新到的字并进当前这条尾巴，冷却之后再起下一条。每个 token 一个 span
 * 会让节点数跟着回复长度长，而这一行是常驻的。
 */

/** 新字从亮到安静的总时长（前 30% 完成淡入）。 */
export const INK_MS = 600

/** 尾巴的起止时刻写在元素上：提交之后按它钉 startTime，与 wave-dom 同一套做法。 */
export const INK_START_ATTRIBUTE = 'data-ink-start'

/**
 * 墨迹的关键帧。
 *
 * 颜色从 `--cp-ticker-ink`（与正文同墨）冷却到 `--cp-timeline-quiet-text`（这一行的安静色）；
 * 透明度只在前 30% 里走完，剩下七成时间都在冷却颜色 ——「写下来」那一下的感觉来自颜色的
 * 变化，不是来自浮现。
 *
 * 颜色两态都由这条动画给：思考句不戴 shimmer（`.timeline-shimmer` 才是那行字颜色的所有者），
 * 所以这里不会跟扫光抢。
 */
const FRAMES: Keyframe[] = [
  { opacity: 0, color: 'var(--cp-ticker-ink)', offset: 0 },
  { opacity: 1, color: 'var(--cp-ticker-ink)', offset: 0.3 },
  { opacity: 1, color: 'var(--cp-timeline-quiet-text)', offset: 1 },
]

export interface InkTail {
  /** 墨迹尾巴从第几个字开始 */
  readonly from: number
  /** 这条尾巴开始的时刻（performance.now 时基） */
  readonly at: number
}

/**
 * 推进墨迹的账：同一段尾巴里继续长字就沿用，上一段冷却之后才另起一条。
 *
 * 渲染期算，所以是纯函数（渲染必须没有副作用）。`at` 用绝对时刻而不是「已经淡了多久」，
 * 动画才能把 startTime 钉住。
 *
 * 首次挂载由调用方处理（它把 `from` 初始化成整句的长度）：这一句第一次出现时那几个字不是
 * 「刚写下的」，它们本来就长在那里 —— 虚拟列表滚出去再滚回来、切回会话都是这条路，让它们
 * 一起亮一遍就成了重播。
 */
export function nextInk(current: InkTail, rendered: number, length: number, now: number): InkTail {
  if (length <= rendered) return current

  /* 上一段还在冷却：新字并进去，不另起一条。 */
  if (now - current.at <= INK_MS) return current

  return { from: rendered, at: now }
}

/** 每个元素一条动画；start 记着这条动画钉在哪个时刻上。 */
const pinned = new WeakMap<Element, { animation: Animation; start: number }>()

/**
 * 提交之后、绘制之前调用（useLayoutEffect）：把动画挂上，或把进度对上。
 *
 * `startTime` 钉在尾巴开始的绝对时刻 —— 节点被 React 换掉时从正确的进度接着走，被复用时
 * 本来就是同一条动画，不动它。
 */
export function syncInk(host: Element, options: { readonly duration?: number; readonly now?: number } = {}): void {
  const node = host.querySelector(`[${INK_START_ATTRIBUTE}]`)

  if (node === null) return

  const start = Number(node.getAttribute(INK_START_ATTRIBUTE))
  const held = pinned.get(node)
  const now = options.now ?? performance.now()

  if (held !== undefined && held.start === start) return

  if (held !== undefined) {
    held.animation.startTime = start
    pinned.set(node, { animation: held.animation, start })

    return
  }

  const timeline = document.timeline.currentTime

  if (timeline === null) return

  /* 动画挂在 document.timeline 时基上，尾巴的开始时刻是 performance.now 时基 —— 两者同源，
     差一个常量：用当前时刻反推它在时间线上的位置。 */
  const animation = node.animate(FRAMES, { duration: options.duration ?? INK_MS, fill: 'both', easing: 'linear' })
  const timelineStart = Number(timeline) - (now - start)

  animation.startTime = timelineStart
  animation.currentTime = Number(timeline) - timelineStart
  pinned.set(node, { animation, start })
}
