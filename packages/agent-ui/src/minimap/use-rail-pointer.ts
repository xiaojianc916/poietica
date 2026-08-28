import { useCallback } from 'react'
import { RAIL_PITCH_PX, railCentre, railWeight, railWindow } from './conversation-minimap-geometry'

/** 指针从轨道朝内容那一侧探出多少就算进入。要调手感就调这一个数。 */
const REACH_INWARD_PX = 28
const REACH_OUTWARD_PX = 16
const TRACK_CLASS = 'conversation-minimap__scroller'
const TURN_CLASS = 'conversation-minimap__turn'
const WEIGHT_VAR = '--cp-rail-weight'
const CARD_Y_VAR = '--cp-rail-card-y'
const AIMED_ATTRIBUTE = 'data-aimed'
/** 低于这个权重与静止无异，写平的 0。 */
const EPSILON = 0.002
interface Span {
  from: number
  to: number
}
const EMPTY: Span = { from: 0, to: -1 }
/** 横向朝内容那一侧探出算数；纵向以可见轨道为界。 */
function inReach(box: DOMRect, x: number, y: number): boolean {
  return (
    !Number.isNaN(x) &&
    x >= box.left - REACH_OUTWARD_PX &&
    x <= box.right + REACH_INWARD_PX &&
    y >= box.top &&
    y <= box.bottom
  )
}
/**
 * Dock magnification，纵向：柱子按到指针的距离拿 0..1 的权重，样式表把它换成长度。
 *
 * 权重逐帧变，所以写成自定义属性而不进 React；「指着第几根」跨格才变，那一件事才
 * 交给 React。两者由同一趟算出，读写落在同一帧，指针几何因此只有一个所有者。
 *
 * 指针跟在 window 上：轨道只有三十来像素宽，真正的边界在它外面。焦点压过指针 ——
 * 人按了 Tab 就是在用键盘，鼠标停在哪里是历史遗留。
 */
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
       * 交给样式表的 ':hover' 与 ':focus-visible'。焦点那一路照常。 */
      const magnifies = !(
        view.matchMedia('(pointer: coarse)').matches ||
        view.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
      let frame = 0
      let pointerX = Number.NaN
      let pointerY = Number.NaN
      let painted = EMPTY
      let pointed = -1
      let focused = -1
      let shown = -1
      const unpaint = (from: number, to: number) => {
        for (let index = from; index <= to; index += 1) {
          bars[index]?.style.removeProperty(WEIGHT_VAR)
        }
      }
      const indexOfBar = (turn: HTMLElement) => {
        for (let index = 0; index < bars.length; index += 1) {
          if (bars[index] === turn) {
            return index
          }
        }
        return -1
      }
      /** 卡片贴着它那一根走；轨道会滚，所以按柱子自己的盒子重算。 */
      const place = (index: number) => {
        const bar = bars[index]
        if (bar === undefined) {
          return
        }
        const box = bar.getBoundingClientRect()
        const top = box.top - node.getBoundingClientRect().top + box.height / 2
        node.style.setProperty(CARD_Y_VAR, `${String(top)}px`)
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
      /** 一段窗口内的柱子按各自权重上色；没变的写零次。 */
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
      const paint = () => {
        frame = 0
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
        if (
          !inReach(rail.getBoundingClientRect(), pointerX, pointerY) ||
          aimed < 0 ||
          aimed >= bars.length
        ) {
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
        const turn =
          target instanceof Element ? target.closest<HTMLElement>(`.${TURN_CLASS}`) : null
        focused = turn === null || !turn.matches(':focus-visible') ? -1 : indexOfBar(turn)
        settle(true)
      }
      const leave = () => {
        focused = -1
        settle(true)
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
