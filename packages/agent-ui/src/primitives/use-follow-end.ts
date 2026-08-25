import { useEffect, useRef } from 'react'

/**
 * 让一行字横向跟着末尾走：正在写的那一行，要看的恰好是最新那几个字。
 *
 * overflow: hidden 只收走用户的滚动手段，盒子仍是滚动容器，scrollLeft 照样生效。
 * 每次渲染后跟一次，一帧最多落一次 —— 读 scrollWidth 会强制回流，而 token 比帧密。
 * 不跟随时归零，下一句从头读。
 */
export function useFollowEnd<T extends HTMLElement>(isFollowing: boolean) {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const element = ref.current

    if (element === null) {
      return
    }

    if (!isFollowing) {
      element.scrollLeft = 0

      return
    }

    const frame = requestAnimationFrame(() => {
      element.scrollLeft = element.scrollWidth - element.clientWidth
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  })

  return ref
}
