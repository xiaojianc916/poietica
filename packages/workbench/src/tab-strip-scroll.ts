import { useLayoutEffect, useState } from 'react'

/*
 * 标签条横向溢出时两端那道渐隐：被裁断的标签会读成「被右边那排按钮挡住」的坏排版，有雾才是「后面还有」。
 *
 * 只报状态，不碰颜色也不碰几何 —— 遮罩画在哪一端是 CSS 的事（见 auxiliary.css 的
 * `.auxiliary-tab-strip__tabs[data-strip-scroll]`），这里只回答「哪一端还藏着东西」。
 */

/** 四态：两端都还藏着、只藏住左端、只藏住右端、全露出来了。值直接写进 data 属性。 */
export type TabStripScroll = 'end' | 'none' | 'start' | 'start end'

export interface TabStripMetrics {
  readonly clientWidth: number
  readonly scrollLeft: number
  readonly scrollWidth: number
}

/** 容差一个像素：scrollLeft 可能是小数，量到的整数边界会差一格，不加它滚到头时那道雾永远擦不掉。 */
const EDGE_TOLERANCE_PX = 1

export function resolveTabStripScroll({ clientWidth, scrollLeft, scrollWidth }: TabStripMetrics): TabStripScroll {
  const hidden = scrollWidth - clientWidth

  if (hidden <= EDGE_TOLERANCE_PX) {
    return 'none'
  }

  const start = scrollLeft > EDGE_TOLERANCE_PX
  const end = scrollLeft < hidden - EDGE_TOLERANCE_PX

  if (start && end) {
    return 'start end'
  }

  if (start) {
    return 'start'
  }

  return end ? 'end' : 'none'
}

/**
 * 尺寸变化有四条来路，缺一条雾就停在错的状态：滚、条自己变形（全屏进出会改行宽）、标签的增删、
 * 单个标签的标题变长（多出来的字会把 scrollWidth 顶大）。
 */
export function useTabStripScroll(): {
  readonly scroll: TabStripScroll
  readonly viewport: (node: HTMLElement | null) => void
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [scroll, setScroll] = useState<TabStripScroll>('none')

  useLayoutEffect(() => {
    if (node === null) {
      setScroll('none')
      return undefined
    }

    const sync = (): void => {
      setScroll((current) => {
        const next = resolveTabStripScroll(node)

        return current === next ? current : next
      })
    }

    sync()
    node.addEventListener('scroll', sync, { passive: true })

    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(sync)
    const watch = (): void => {
      if (resize !== undefined) {
        resize.disconnect()
        resize.observe(node)

        for (const child of node.children) {
          resize.observe(child)
        }
      }

      sync()
    }
    watch()

    const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(watch)
    mutations?.observe(node, { childList: true })

    /* 没有 ResizeObserver 的环境（旧引擎、测试替身）靠窗口尺寸兜底，别当冗余删掉。 */
    window.addEventListener('resize', sync)

    return () => {
      node.removeEventListener('scroll', sync)
      resize?.disconnect()
      mutations?.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [node])

  /* 回调 ref 的身份来自 useState，天然稳定：换成内联箭头会每次都重挂一遍观测。 */
  return { scroll, viewport: setNode }
}
