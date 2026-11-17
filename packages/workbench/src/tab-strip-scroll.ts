import { useScrollEnds } from '@poietica/design-system'

/*
 * 标签条横向溢出时两端那道渐隐：被裁断的标签会读成「被右边那排按钮挡住」的坏排版，有雾才是「后面还有」。
 *
 * 只报状态，不碰颜色也不碰几何 —— 遮罩画在哪一端是 CSS 的事（见 auxiliary.css 的
 * `.auxiliary-tab-strip__tabs[data-strip-scroll]`），这里只回答「哪一端还藏着东西」。
 * 观测与容差在 design-system 的 useScrollEnds，这里只把横向两端折成 data 属性认的写法。
 */

/** 四态：两端都还藏着、只藏住左端、只藏住右端、全露出来了。值直接写进 data 属性。 */
export type TabStripScroll = 'end' | 'none' | 'start' | 'start end'

export function useTabStripScroll(): {
  readonly scroll: TabStripScroll
  readonly viewport: (node: HTMLElement | null) => void
} {
  const { start, end, viewport } = useScrollEnds('x')
  const scroll: TabStripScroll = start ? (end ? 'start end' : 'start') : end ? 'end' : 'none'

  return { scroll, viewport }
}
