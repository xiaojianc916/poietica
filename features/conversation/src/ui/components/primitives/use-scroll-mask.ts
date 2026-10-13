import { useLayoutEffect, useState } from 'react'

/**
 * 自己滚的盒子两端那道雾：内容被切掉时断口会读成坏掉的排版，有雾才是「下面还有」，滚到那一端雾就消失。
 *
 * 只算状态、不认识颜色也不改几何 —— 这些行挂着虚拟器的 measureElement，会改高度的东西在这里不能碰。
 */

/** 四态：两端都还藏着、只藏住上端、只藏住下端、全露出来了。 */
export type ScrollMaskState = 'both' | 'bottom' | 'none' | 'top'

export interface ScrollMetrics {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/** 容差一个像素：scrollTop 是小数而 clientHeight / scrollHeight 是整数，没有它滚到顶端时 scrollTop 可能是 0.5，上端那道雾永远擦不掉。 */
const FADE_TOLERANCE_PX = 1

export function resolveScrollMaskState({ clientHeight, scrollHeight, scrollTop }: ScrollMetrics): ScrollMaskState {
  const hidden = scrollHeight - clientHeight

  if (hidden <= FADE_TOLERANCE_PX) {
    return 'none'
  }

  const top = scrollTop > FADE_TOLERANCE_PX
  const bottom = scrollTop < hidden - FADE_TOLERANCE_PX

  if (top && bottom) {
    return 'both'
  }

  if (top) {
    return 'top'
  }

  return bottom ? 'bottom' : 'none'
}

/**
 * 尺寸变化有四条来路，缺一条雾就停在错的状态：滚、盒自己变形（宽变窄会让每行折行）、内容长高（行自己的抽屉也在这条链上）、行的增删。
 */
export function useScrollMask(): {
  readonly mask: ScrollMaskState
  readonly viewport: (node: HTMLElement | null) => void
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [mask, setMask] = useState<ScrollMaskState>('none')

  useLayoutEffect(() => {
    if (node === null) {
      setMask('none')
      return undefined
    }

    const sync = (): void => {
      setMask((current) => {
        const next = resolveScrollMaskState(node)

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
  return { mask, viewport: setNode }
}
