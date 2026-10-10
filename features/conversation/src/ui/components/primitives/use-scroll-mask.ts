import { useLayoutEffect, useState } from 'react'

/**
 * 自己滚的盒子两端那道雾。
 *
 * 盒子里的内容比盒高时，被切掉的那一行不能是「一刀切」—— 断口会让它读成一个坏掉的
 * 排版，而不是「下面还有」。有雾的那一端才是「这里藏着东西」的记号，滚到那一端雾就
 * 消失：记号说的是还有多少没露出，不是「这是个滚动盒」。
 *
 * 判据与画法分开，照 zcode-ref 的 scrollMask.ts 那套：这里只按实际滚动量算出四态，
 * 渐变归样式表（消费处按 data-scroll-mask 画）。于是这个 hook 不认识任何颜色，也不改
 * 盒子的几何 —— 这些行挂着虚拟器的 measureElement，会改高度的东西在这里不能碰。
 */

/** 四态：两端都还藏着、只藏住上端、只藏住下端、全露出来了。 */
export type ScrollMaskState = 'both' | 'bottom' | 'none' | 'top'

export interface ScrollMetrics {
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly scrollTop: number
}

/**
 * 容差一个像素。
 *
 * scrollTop 是小数（缩放、亚像素行高都会），而 clientHeight / scrollHeight 是整数：
 * 不做容差的话，滚到顶端时 scrollTop 可能是 0.5，上端那道雾就永远擦不掉。
 */
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
 * 盒子的 ref 与此刻该不该有雾。
 *
 * 尺寸变化有四条来路，缺一条雾就会停在错的状态上：滚（scroll）、盒自己变形（宽变窄
 * 会让每一行折行）、内容长高（观测每个孩子，行自己的抽屉也在这条链上）、行的增删
 * （孩子换了要重挂观测）。所以是 ResizeObserver 加 MutationObserver，不是只监听滚动。
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

    /* 没有 ResizeObserver 的环境（旧引擎、测试替身）还靠窗口尺寸兜底。 */
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
