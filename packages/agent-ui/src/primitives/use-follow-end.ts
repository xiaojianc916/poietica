import { useEffect, useRef } from 'react'

/** 合并到第几帧写一次：token 比帧密，每帧写等于每帧强制一次回流。 */
const COALESCE_FRAMES = 3

/**
 * 让一行字横向跟着末尾走：正在写的那一行，要看的恰好是最新那几个字。
 *
 * overflow: hidden 只收走用户的滚动手段，盒子仍是滚动容器，scrollLeft 照样生效。
 *
 * 已排期的那一帧只合并、不取消。取消式的写法在快流下一次也落不了地：每次渲染注册一帧，
 * 上一次渲染的清理先把它撤掉，于是 scrollLeft 从未被写过，行看着停在旧位置 —— 而字还在
 * 往右长。做法取自 deepseek-harness 的
 * packages/client/ui-conversation/src/client/chat/use-throttled-visual-update.ts。
 */
export function useFollowEnd<T extends HTMLElement>(isFollowing: boolean) {
  const ref = useRef<T | null>(null)
  const pending = useRef<number | null>(null)

  useEffect(() => {
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

      if (target !== null) {
        target.scrollLeft = target.scrollWidth - target.clientWidth
      }
    }

    pending.current = requestAnimationFrame(advance)
  })

  /* 谁创建谁销毁：挂着的那一帧属于这个 hook 的整段寿命，只在卸载时撤。 */
  useEffect(
    () => () => {
      if (pending.current !== null) {
        cancelAnimationFrame(pending.current)
        pending.current = null
      }
    },
    [],
  )

  return ref
}
