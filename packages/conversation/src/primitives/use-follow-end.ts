import { useLayoutEffect, useRef } from 'react'

/* 三帧一次写：与 deepseek-harness 的 packages/client/ui-chat/src/client/chat/use-throttled-visual-update.ts 同一个数。 */
const COALESCE_FRAMES = 3

/**
 * 把一格单行文本钉在它的末端。
 *
 * 位置归这里，动感归样式表：跟随中的那一格挂 data-follow-end，flow-row.css 在
 * prefers-reduced-motion: no-preference 下给它 scroll-behavior: smooth。于是同一次赋值由
 * 渲染器插值成从右往左的滑动，下一次赋值重定向进行中的那一次而不是重放它（CSSOM View：
 * scrollLeft 的赋值按元素自身的 scroll-behavior 滚动）。手写补间会和它抢同一个属性。
 *
 * 不取消：每次渲染注册一帧、上一次渲染的清理先把它撤掉，快流下一帧也落不了地。排期中的
 * 那一帧落地前重读意图 —— 落定与它之间隔着几帧，不重读就会把已经换成首行的那一格推到末端。
 */
export function useFollowEnd<T extends HTMLElement>(isFollowing: boolean) {
  const ref = useRef<T | null>(null)
  const following = useRef(isFollowing)
  const pending = useRef<number | null>(null)

  useLayoutEffect(() => {
    following.current = isFollowing

    const element = ref.current

    if (element === null) {
      return
    }

    if (!isFollowing) {
      element.scrollLeft = 0

      return
    }

    if (pending.current !== null) {
      return
    }

    let frames = COALESCE_FRAMES

    const advance = () => {
      frames -= 1

      if (frames > 0) {
        pending.current = requestAnimationFrame(advance)

        return
      }

      pending.current = null

      const target = ref.current

      if (target === null) {
        return
      }

      target.scrollLeft = following.current ? target.scrollWidth - target.clientWidth : 0
    }

    pending.current = requestAnimationFrame(advance)
  })

  useLayoutEffect(
    () => () => {
      if (pending.current !== null) {
        cancelAnimationFrame(pending.current)
      }
    },
    [],
  )

  return ref
}
