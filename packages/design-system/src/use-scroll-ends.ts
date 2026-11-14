import { useLayoutEffect, useState } from 'react'

/*
 * 自己滚的盒子两端还藏着多少：纵向的正文 / 工具组与横向的标签条共用这一条观测，
 * 差别只在量哪一根轴。只算状态，不认识颜色也不改几何 —— 挂着虚拟器 measureElement 的
 * 容器不能在这里改高度。
 */

/** 容差一个像素：滚动位置可能是小数而 client / scroll 尺寸是整数，没有它滚到头时那一端永远擦不掉。 */
const EDGE_TOLERANCE_PX = 1

export interface ScrollEnds {
  readonly start: boolean
  readonly end: boolean
}

export interface ScrollEndsInput {
  readonly clientSize: number
  readonly scrollSize: number
  readonly position: number
}

/** 两端各自还有没有藏起来的内容。 */
export function scrollEndsOf({ clientSize, scrollSize, position }: ScrollEndsInput): ScrollEnds {
  const hidden = scrollSize - clientSize

  if (hidden <= EDGE_TOLERANCE_PX) {
    return { start: false, end: false }
  }

  return { start: position > EDGE_TOLERANCE_PX, end: position < hidden - EDGE_TOLERANCE_PX }
}

/**
 * 尺寸变化有四条来路，缺一条雾就停在错的状态：滚、盒自己变形（宽变窄会让每行折行）、
 * 内容长高（行自己的抽屉也在这条链上）、行的增删。
 */
export function useScrollEnds(axis: 'x' | 'y'): {
  readonly start: boolean
  readonly end: boolean
  readonly viewport: (node: HTMLElement | null) => void
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [ends, setEnds] = useState<ScrollEnds>({ start: false, end: false })

  /* 清理函数在末尾统一断开 scroll / resize / 两个观察器；规则只认「观察器创建后直接返回清理」那一形状。 */
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useLayoutEffect(() => {
    if (node === null) {
      setEnds({ start: false, end: false })
      return undefined
    }

    const sync = (): void => {
      const next =
        axis === 'x'
          ? scrollEndsOf({ clientSize: node.clientWidth, position: node.scrollLeft, scrollSize: node.scrollWidth })
          : scrollEndsOf({ clientSize: node.clientHeight, position: node.scrollTop, scrollSize: node.scrollHeight })
      setEnds((current) => (current.start === next.start && current.end === next.end ? current : next))
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
  }, [axis, node])

  /* 回调 ref 的身份来自 useState，天然稳定：换成内联箭头会每次都重挂一遍观测。 */
  return { ...ends, viewport: setNode }
}
