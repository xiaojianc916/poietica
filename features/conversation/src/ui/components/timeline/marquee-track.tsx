import { useLayoutEffect, useRef } from 'react'
import { INK_START_ATTRIBUTE, nextInk, syncInk } from './ink-tail'
import { type MarqueeMode, useMarquee } from './use-marquee'

/*
 * 一句话的横向轨道。
 *
 * 窗口与轨道都由它自己渲染 —— 一句话一套。左侧淡出因此挂在**每一句自己的窗口**上：换句时
 * 退场的旧句带着自己的淡出一起刷走，新句从 x=0 开始、没有淡出，两者互不干扰。挂在容器最外层
 * 的话，新句一出场就把淡出撤掉，正在退场的旧句左边会露出一个硬切口。
 *
 * 不做 memo：它每次都跟着 text 变（流式），而且只在换句时由容器重建。
 */

export interface MarqueeTrackProps {
  readonly text: string
  readonly mode: MarqueeMode
  /** 只有思考句开墨迹：戴 shimmer 的两处（占位、工具行）都不开，颜色归扫光。 */
  readonly ink: boolean
  readonly reduced: boolean
  /** 划到位（或不需要划）时调用一次。 */
  readonly onSettled: () => void
}

export function MarqueeTrack({ text, mode, ink, reduced, onSettled }: MarqueeTrackProps) {
  const refs = useMarquee({ mode, reduced, onSettled })
  /*
   * 墨迹的账。`shown` 是上一轮渲染到了第几个字，尾巴从那里起。
   *
   * 初始值取「整句都算冷的」：这一句第一次出现时那几个字不是刚写下的，它们本来就长在那里
   * （虚拟列表滚出去再滚回来、切回会话都走这条路），让它们一起亮一遍就成了重播。
   */
  const shown = useRef(text.length)
  const tail = useRef({ from: text.length, at: 0 })

  const enabled = ink && !reduced
  /* 渲染期算账，但不写 DOM：算出来的时刻写在属性上，提交之后按它钉动画。 */
  tail.current = enabled
    ? nextInk(tail.current, shown.current, text.length, performance.now())
    : { from: text.length, at: 0 }

  const from = tail.current.from
  const cooled = text.slice(0, from)
  const fresh = text.slice(from)

  shown.current = text.length

  useLayoutEffect(() => {
    if (enabled && refs.node() !== null) syncInk(refs.node() ?? document.body)
  })

  return (
    <span className="ticker-window" ref={refs.viewport}>
      <span className="ticker-track" data-mode={mode} ref={refs.track}>
        {cooled}
        {fresh === '' ? null : (
          <span className="ticker-ink" {...{ [INK_START_ATTRIBUTE]: tail.current.at }}>
            {fresh}
          </span>
        )}
      </span>
    </span>
  )
}
