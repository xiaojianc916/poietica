import { useCallback } from 'react'
import { RAIL_PITCH_PX, railCentre, railWeight, railWindow } from './conversation-minimap-geometry'

/** 指针从轨道朝内容那一侧探出多少就算进入；要调手感就改这一个数。 */
const REACH_INWARD_PX = 28
const REACH_OUTWARD_PX = 16
const TRACK_CLASS = 'conversation-minimap__scroller'
const TURN_CLASS = 'conversation-minimap__turn'
const WEIGHT_VAR = '--cp-rail-weight'
const CARD_Y_VAR = '--cp-rail-card-y'
const AIMED_ATTRIBUTE = 'data-aimed'
const EPSILON = 0.002
/* 卡片贴行的滑行：临界阻尼弹簧（ω≈22 rad/s，落定约 300ms，与原 320ms 缓动同一手感）。
 * 不写成 CSS transition：过渡的目标一变就从零速重启，指针连续跨格时位置卡住不动、停下才走完
 * 最后一段，看起来就是一顿再瞬移 —— 弹簧从当前位置和当前速度接着走，没有这件事。 */
const CARD_OMEGA = 22
/** 单帧时间步上限：掉帧或标签页回来时，不让弹簧一步跨过半个行程。 */
const CARD_MAX_DT_S = 0.032
const CARD_SETTLE_PX = 0.25
const CARD_SETTLE_V = 2
/** 目标视为「同一根」的容差：柱子的盒子读数带小数，抖一点点不算换格。 */
const CARD_SAME_PX = 0.1
interface Span {
  from: number
  to: number
}
const EMPTY: Span = { from: 0, to: -1 }
function inReach(box: DOMRect, x: number, y: number): boolean {
  return (
    !Number.isNaN(x) &&
    x >= box.left - REACH_OUTWARD_PX &&
    x <= box.right + REACH_INWARD_PX &&
    y >= box.top &&
    y <= box.bottom
  )
}
/** 柱子按到指针的距离拿 0..1 权重，样式表把它换成长度：权重逐帧变走自定义属性，只有「指着第几根」跨格才变、交给 React。
 * 指针跟在 window 上（轨道只有三十来像素宽，真正的边界在它外面）；焦点压过指针 —— 按了 Tab 就是在用键盘。 */
export function useRailPointer(
  onShow: (index: number) => void,
): (node: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (node: HTMLElement | null) => {
      if (node === null) {
        return undefined
      }
      const view = node.ownerDocument.defaultView
      if (view === null) {
        return undefined
      }
      const bars = node.getElementsByClassName(TURN_CLASS) as HTMLCollectionOf<HTMLElement>
      /* 命中盒是可见轨道：nav 铺满整栏，拿它当边界等于整栏都能命中。 */
      const rails = node.getElementsByClassName(TRACK_CLASS) as HTMLCollectionOf<HTMLElement>
      /* 粗指针与减弱动效下不放大：内联自定义属性盖得过媒体查询，所以在这里退场，
       * 交给样式表的 ':hover' 与 ':focus-visible'；焦点那一路照常。 */
      const magnifies = !(
        view.matchMedia('(pointer: coarse)').matches || view.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
      /* 减弱动效下贴行不做滑行：跨格直接给到位。 */
      const glides = !view.matchMedia('(prefers-reduced-motion: reduce)').matches
      let frame = 0
      let pointerX = Number.NaN
      let pointerY = Number.NaN
      let painted = EMPTY
      let pointed = -1
      let focused = -1
      let shown = -1
      let cardY = Number.NaN
      let cardV = 0
      let cardTarget = Number.NaN
      let cardAt = 0
      let cardMoving = false
      const unpaint = (from: number, to: number) => {
        for (let index = from; index <= to; index += 1) {
          bars[index]?.style.removeProperty(WEIGHT_VAR)
        }
      }
      /* 下标由柱子自己带在身上：焦点进来时读一次，不必按 DOM 顺序线性扫。 */
      const indexOfBar = (turn: HTMLElement) => {
        const held = Number(turn.dataset.minimapIndex)

        return Number.isInteger(held) ? held : -1
      }
      /** 卡片贴着它那一根走；轨道会滚，所以按柱子自己的盒子重算。这里只写目标，位移交给 glide。 */
      const place = (index: number) => {
        const bar = bars[index]
        if (bar === undefined) {
          return
        }
        const box = bar.getBoundingClientRect()
        const top = box.top - node.getBoundingClientRect().top + box.height / 2
        /* 第一次落位与减弱动效直接给到位：没有别的东西在动，滑行只会显得慢。 */
        if (Number.isNaN(cardY) || !glides) {
          cardY = top
          cardV = 0
          cardTarget = top
          cardMoving = false
          node.style.setProperty(CARD_Y_VAR, `${cardY.toFixed(2)}px`)
          return
        }
        if (Math.abs(top - cardTarget) > CARD_SAME_PX) {
          cardTarget = top
          if (!cardMoving) {
            /* 上一趟已经停表：这一趟的第一帧只对时，速度从零起。 */
            cardAt = 0
            cardMoving = true
          }
        }
      }
      const settle = (notify: boolean) => {
        const next = focused >= 0 ? focused : pointed
        if (next !== shown) {
          bars[shown]?.removeAttribute(AIMED_ATTRIBUTE)
          bars[next]?.setAttribute(AIMED_ATTRIBUTE, '')
          shown = next
          if (notify) {
            onShow(next)
          }
        }
        if (next >= 0) {
          place(next)
        }
      }
      const clear = () => {
        unpaint(painted.from, painted.to)
        painted = EMPTY
        pointed = -1
        settle(true)
      }
      const paintWeights = (span: Span, anchor: number) => {
        for (let index = span.from; index <= span.to; index += 1) {
          const bar = bars[index]
          if (bar === undefined) {
            continue
          }
          const weight = railWeight(railCentre(index) - anchor)
          const next = weight < EPSILON ? '0' : weight.toFixed(3)
          if (bar.style.getPropertyValue(WEIGHT_VAR) !== next) {
            bar.style.setProperty(WEIGHT_VAR, next)
          }
        }
      }
      /** 位置那一半：逐帧把卡片追到目标，落定后自己停表。 */
      const glide = (now: number): boolean => {
        if (!cardMoving) {
          return false
        }
        const dt = cardAt === 0 ? 0 : Math.min((now - cardAt) / 1000, CARD_MAX_DT_S)
        cardAt = now
        cardV += (-CARD_OMEGA * CARD_OMEGA * (cardY - cardTarget) - 2 * CARD_OMEGA * cardV) * dt
        cardY += cardV * dt
        if (Math.abs(cardTarget - cardY) <= CARD_SETTLE_PX && Math.abs(cardV) <= CARD_SETTLE_V) {
          cardY = cardTarget
          cardV = 0
          cardMoving = false
        }
        node.style.setProperty(CARD_Y_VAR, `${cardY.toFixed(2)}px`)
        return cardMoving
      }
      /** 指针那一半：命中、权重与「指着第几根」。 */
      const updateAim = () => {
        const rail = rails[0]
        const first = bars[0]
        if (!magnifies || rail === undefined || first === undefined) {
          clear()
          return
        }
        /* 落点取自柱子自己的盒子：这个读数已经含了轨道的滚动位移。 */
        const anchor = pointerY - first.getBoundingClientRect().top
        /* 指着第几根是包含判定：格高就是步距，格外没有「最近的一根」。 */
        const aimed = Math.floor(anchor / RAIL_PITCH_PX)
        if (!inReach(rail.getBoundingClientRect(), pointerX, pointerY) || aimed < 0 || aimed >= bars.length) {
          clear()
          return
        }
        const span = railWindow(anchor, bars.length)
        unpaint(painted.from, Math.min(painted.to, span.from - 1))
        unpaint(Math.max(painted.from, span.to + 1), painted.to)
        painted = span
        paintWeights(span, anchor)
        pointed = aimed
        settle(true)
      }
      const paint = (now: number) => {
        frame = 0
        updateAim()
        if (glide(now)) {
          schedule()
        }
      }
      const schedule = () => {
        if (frame === 0) {
          frame = view.requestAnimationFrame(paint)
        }
      }
      const track = (event: PointerEvent) => {
        pointerX = event.clientX
        pointerY = event.clientY
        schedule()
      }
      const release = () => {
        pointerX = Number.NaN
        pointerY = Number.NaN
        schedule()
      }
      const enter = (event: FocusEvent) => {
        const target = event.target
        const turn = target instanceof Element ? target.closest<HTMLElement>(`.${TURN_CLASS}`) : null
        focused = turn === null || !turn.matches(':focus-visible') ? -1 : indexOfBar(turn)
        settle(true)
        /* 键盘那条路没有 pointermove 来踢这一趟，自己叫一帧。 */
        schedule()
      }
      const leave = () => {
        focused = -1
        settle(true)
        /* 交还给指针那一根时也要踢一帧，否则卡片停在键盘那一格不再走。 */
        schedule()
      }
      view.addEventListener('pointermove', track, { passive: true })
      view.addEventListener('pointerdown', track, { passive: true })
      view.addEventListener('blur', release)
      node.ownerDocument.addEventListener('pointerleave', release, { passive: true })
      /* scroll 不冒泡，走捕获：轨道滚动时卡片要跟着它那一根。 */
      node.addEventListener('scroll', schedule, { capture: true, passive: true })
      node.addEventListener('focusin', enter)
      node.addEventListener('focusout', leave)
      return () => {
        if (frame !== 0) {
          view.cancelAnimationFrame(frame)
        }
        view.removeEventListener('pointermove', track)
        view.removeEventListener('pointerdown', track)
        view.removeEventListener('blur', release)
        node.ownerDocument.removeEventListener('pointerleave', release)
        node.removeEventListener('scroll', schedule, { capture: true })
        node.removeEventListener('focusin', enter)
        node.removeEventListener('focusout', leave)
        unpaint(painted.from, painted.to)
        bars[shown]?.removeAttribute(AIMED_ATTRIBUTE)
      }
    },
    [onShow],
  )
}
