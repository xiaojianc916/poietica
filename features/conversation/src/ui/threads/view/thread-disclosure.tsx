import type { ReactNode, TransitionEvent } from 'react'
import { useEffect, useState } from 'react'
import { EXIT_SECONDS } from '../../shared/primitives/motion'

/*
 * 不用 motion 逐帧补 height：height/width 一类布局属性每帧都会让浏览器重新排版，长列表里正是卡顿的来源。
 * 改成 grid-template-rows 的 0fr↔1fr —— 浏览器只补这一条轨道，内容仍按自己的高度排版；时长与曲线在
 * assistant-threads.css 里与 motion.ts 的 ENTER/EXIT 保持同值。
 *
 * 内容仍只在打开时挂载：收起动画走完再摘掉。这一列可能挂几百条会话，不能为了动画让收起的内容常驻 DOM。
 */

type Phase = 'closed' | 'opening' | 'open' | 'closing'

export interface ThreadDisclosureProps {
  readonly children: ReactNode
  readonly isOpen: boolean
}

export function ThreadDisclosure({ children, isOpen }: ThreadDisclosureProps) {
  /* 首次挂载就开着时不播入场：那不是一次交互（与原先 AnimatePresence initial={false} 同义）。 */
  const [phase, setPhase] = useState<Phase>(isOpen ? 'open' : 'closed')

  /*
   * 渲染期对齐 props（React 的「adjusting state when props change」），不放 effect：
   *   · 少一次提交，首帧就是最终的 data-open；
   *   · 从收起状态打开先落一帧 0fr（opening），CSS 才有起点可补；首次挂载已是 open，不经过这里；
   *   · 收起途中又打开：直接回到 open，让 CSS 从当前高度反向补间，不再先落回 0fr 造成一次下顿；
   *   · 系统要求减少动态时不补间：没有收起的等待，直接摘掉。
   * setPhase 后 React 会立刻重渲染，下面的 JSX 读到的就是新 phase。
   */
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (isOpen && (phase === 'closed' || phase === 'closing')) {
    setPhase(phase === 'closed' && !reduced ? 'opening' : 'open')
  } else if (!isOpen && (phase === 'open' || phase === 'opening')) {
    setPhase(reduced ? 'closed' : 'closing')
  }

  /* opening 只停一帧：等 0fr 的样式提交后再切到 1fr，否则同一帧内两个值之间没有补间。 */
  useEffect(() => {
    if (phase !== 'opening') return undefined
    const frame = requestAnimationFrame(() => {
      setPhase('open')
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  /*
   * 收起结束由壳自己的补间报告（transitionend），比按 EXIT_SECONDS 计时准：补间被延后、被掐断它都知道。
   * 兜底计时器管「补间根本没跑」的情形 —— 窗口不可见、元素没被绘制时 transitionend 不会来，内容不能一直挂着。
   * 上限取两倍退出时长：正常路径总先到，这里只在异常路径上收尾。
   */
  useEffect(() => {
    if (phase !== 'closing') return undefined
    const timer = window.setTimeout(
      () => {
        setPhase('closed')
      },
      EXIT_SECONDS * 2 * 1000,
    )
    return () => window.clearTimeout(timer)
  }, [phase])

  /* 只认壳自己这条轨道：内层行也有补间，事件会冒泡上来，别让别人的结束替这一层收尾。 */
  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows') return
    if (phase !== 'closing') return
    setPhase('closed')
  }

  if (phase === 'closed') return null

  return (
    <div
      className="thread-disclosure"
      data-open={phase === 'open' ? 'true' : 'false'}
      inert={!isOpen}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="thread-disclosure__inner">{children}</div>
    </div>
  )
}
