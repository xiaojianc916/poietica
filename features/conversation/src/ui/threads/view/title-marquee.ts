import type { RefObject } from 'react'
import { useEffect, useMemo, useRef } from 'react'

/*
 * 侧栏会话标题的悬停横移（正本 DSH UI 的 SessionNodeItem / useTitleMarquee）：
 * 标题放不下时，指针停在整行上就让它以恒定速度向左爬，爬到远端停下；
 * 指针离开立即回开头（不补间 —— 回程会把静息省略号一路带着走）。
 * 溢出不足 8px 不动：只裁掉一两个像素时爬几下读起来像抖动，不像揭示。
 */

/** 这点溢出藏不住有意义的尾巴，不值得动。 */
const MIN_TITLE_REVEAL_PX = 8

/** 30px/s：慢到能把经过的字读出来。 */
const TITLE_MARQUEE_PX_PER_MS = 0.03

/**
 * 把标题放到指定位置，并同步两端渐隐的样式钩子：
 * 离开开头时挂 data-scrolled（左端渐隐），右边还有字没露出来时挂 data-clipped（右端渐隐）。
 */
function placeTitle(title: HTMLSpanElement, left: number, range: number): void {
  if (typeof title.scrollTo === 'function') {
    title.scrollTo({ left, behavior: 'instant' })
  } else {
    title.scrollLeft = left
  }

  if (left > 0) {
    title.setAttribute('data-scrolled', '')
  } else {
    title.removeAttribute('data-scrolled')
  }

  if (left < range) {
    title.setAttribute('data-clipped', '')
  } else {
    title.removeAttribute('data-clipped')
  }
}

/** 回到静息：位置归零、两端渐隐都摘掉，省略号以原样出现。 */
function restTitle(title: HTMLSpanElement): void {
  if (typeof title.scrollTo === 'function') {
    title.scrollTo({ left: 0, behavior: 'instant' })
  } else {
    title.scrollLeft = 0
  }

  title.removeAttribute('data-scrolled')
  title.removeAttribute('data-clipped')
}

/**
 * 会话行悬停时横移放不下的标题。
 *
 * 调用方把 ref 指向真正会被裁的那一层：普通标题是整枚 span；带分叉序号时是正文那一段，
 * 序号本身留在行尾不跟着跑。
 */
export function useTitleMarquee(title: RefObject<HTMLSpanElement | null>): {
  readonly enter: () => void
  readonly leave: () => void
} {
  const frame = useRef(0)

  useEffect(
    () => () => {
      window.cancelAnimationFrame(frame.current)
    },
    [],
  )

  return useMemo(
    () => ({
      enter: (): void => {
        if (title.current === null) {
          return
        }

        const element = title.current
        const range = element.scrollWidth - element.clientWidth

        /* 放得下，或只差一点点：不动。 */
        if (range <= MIN_TITLE_REVEAL_PX) {
          return
        }

        /* 减少动态时直接跳到远端，不逐帧爬。 */
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true) {
          placeTitle(element, range, range)
          return
        }

        window.cancelAnimationFrame(frame.current)

        let previous: number | undefined
        let position = 0

        const step = (now: DOMHighResTimeStamp): void => {
          position += previous === undefined ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS
          previous = now
          placeTitle(element, Math.min(position, range), range)

          if (position < range) {
            frame.current = window.requestAnimationFrame(step)
          }
        }

        frame.current = window.requestAnimationFrame(step)
      },
      leave: (): void => {
        window.cancelAnimationFrame(frame.current)

        if (title.current === null) {
          return
        }

        restTitle(title.current)
      },
    }),
    [title],
  )
}
