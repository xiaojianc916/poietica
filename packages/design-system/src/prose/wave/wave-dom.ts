import { WAVE, WAVE_MARKER_ATTRIBUTE, WAVE_START_ATTRIBUTE, type WaveOptions } from './wave-reveal'

const KEYFRAMES: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]
const MARKER_KEYFRAMES: Keyframe[] = [{ color: 'transparent' }, {}]
const EASING = 'cubic-bezier(0.33, 0, 0.2, 1)'
const SELECTOR = `[${WAVE_START_ATTRIBUTE}],[${WAVE_MARKER_ATTRIBUTE}]`

/** animation 为 null = 这个元素被判「直接实显」 */
interface Pinned {
  animation: Animation | null
  start: number
}
const body = new WeakMap<Element, Pinned>()
const marker = new WeakMap<Element, Pinned>()

interface Fresh {
  readonly el: Element
  readonly start: number
  readonly map: WeakMap<Element, Pinned>
  readonly isMarker: boolean
}

/**
 * 提交之后、绘制之前调用（useLayoutEffect）。只扫本段正文的子树，按文档顺序。
 * 每个动画的 startTime 钉在小段的绝对启动时刻：节点被 React 复用给另一段、或被挪动，
 * 进度立即对上，不重播、不截断。
 */
export function syncWave(host: Element, options: WaveOptions = WAVE): void {
  const fresh: Fresh[] = []
  const visit = (el: Element, attribute: string, map: WeakMap<Element, Pinned>, isMarker: boolean) => {
    const raw = el.getAttribute(attribute)
    if (raw === null) return
    const start = Number(raw)
    const pinned = map.get(el)
    if (pinned !== undefined && pinned.start === start) return
    if (pinned?.animation) {
      pinned.animation.startTime = start
      pinned.start = start
      return
    }
    fresh.push({ el, start, map, isMarker })
  }
  for (const el of host.querySelectorAll(SELECTOR)) {
    visit(el, WAVE_MARKER_ATTRIBUTE, marker, true)
    visit(el, WAVE_START_ATTRIBUTE, body, false)
  }
  const timing: KeyframeAnimationOptions = { duration: options.fadeMs, easing: EASING, fill: 'backwards' }
  /* 一次来得太多（从后台切回、长时间卡顿后）：只让最后 maxFreshPerCommit 个淡入 */
  const skip = Math.max(0, fresh.length - options.maxFreshPerCommit)
  fresh.forEach(({ el, start, map, isMarker }, index) => {
    if (index < skip) {
      map.set(el, { animation: null, start })
      return
    }
    const animation = isMarker
      ? el.animate(MARKER_KEYFRAMES, { ...timing, pseudoElement: '::marker' })
      : el.animate(KEYFRAMES, timing)
    animation.startTime = start
    map.set(el, { animation, start })
  })
}
