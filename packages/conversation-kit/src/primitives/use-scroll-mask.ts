import { scrollEndsOf, useScrollEnds } from '@poietica/design-system'

/**
 * 自己滚的盒子两端那道雾：内容被切掉时断口会读成坏掉的排版，有雾才是「下面还有」，滚到那一端雾就消失。
 *
 * 只算状态、不认识颜色也不改几何 —— 这些行挂着虚拟器的 measureElement，会改高度的东西在这里不能碰。
 * 观测与容差在 design-system 的 useScrollEnds，这里只把纵向两端折成 CSS 认的四态。
 */

/** 四态：两端都还藏着、只藏住上端、只藏住下端、全露出来了。 */
export type ScrollMaskState = 'both' | 'bottom' | 'none' | 'top'

export interface ScrollMetrics {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

export function resolveScrollMaskState({ clientHeight, scrollHeight, scrollTop }: ScrollMetrics): ScrollMaskState {
  const { start, end } = scrollEndsOf({ clientSize: clientHeight, scrollSize: scrollHeight, position: scrollTop })

  if (start) {
    return end ? 'both' : 'top'
  }

  return end ? 'bottom' : 'none'
}

export function useScrollMask(): {
  readonly mask: ScrollMaskState
  readonly viewport: (node: HTMLElement | null) => void
} {
  const { start, end, viewport } = useScrollEnds('y')
  const mask: ScrollMaskState = start ? (end ? 'both' : 'top') : end ? 'bottom' : 'none'

  return { mask, viewport }
}
