import type { ReactNode } from 'react'
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

/** 收起结束的调度口；默认等真实补间走完，测试可换成手动触发的一份。 */
export type ExitScheduler = (close: () => void, ms: number) => () => void

const scheduleTimeout: ExitScheduler = (close, ms) => {
  const timer = window.setTimeout(close, ms)
  return () => window.clearTimeout(timer)
}

export interface ThreadDisclosureProps {
  readonly children: ReactNode
  readonly isOpen: boolean
  /** 收起结束的调度口；测试传手动调度，不必用真实计时器等 140ms。 */
  readonly schedule?: ExitScheduler
}

export function ThreadDisclosure({ children, isOpen, schedule = scheduleTimeout }: ThreadDisclosureProps) {
  /* 首次挂载就开着时不播入场：那不是一次交互（与原先 AnimatePresence initial={false} 同义）。 */
  const [phase, setPhase] = useState<Phase>(isOpen ? 'open' : 'closed')

  useEffect(() => {
    if (isOpen) {
      /* 从收起状态打开时先落一帧 0fr，再切到 1fr，CSS 才有起点可补；首次挂载已是 open，不经过这里。 */
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      /* 收起途中又打开：直接回到 open，让 CSS 从当前高度反向补间，不再先落回 0fr 造成一次下顿。 */
      setPhase((held) => (held === 'closed' && !reduced ? 'opening' : 'open'))
      return
    }
    setPhase((held) => (held === 'closed' ? held : 'closing'))
  }, [isOpen])

  /* opening 只停一帧：等 0fr 的样式提交后再切到 1fr，否则同一帧内两个值之间没有补间。 */
  useEffect(() => {
    if (phase !== 'opening') return undefined
    const frame = requestAnimationFrame(() => {
      setPhase('open')
    })
    return () => cancelAnimationFrame(frame)
  }, [phase])

  /* 收起：等 CSS 补间走完再卸内容。系统要求减少动态时不补间，直接卸。 */
  useEffect(() => {
    if (phase !== 'closing') return undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setPhase('closed')
      return undefined
    }
    return schedule(() => {
      setPhase('closed')
    }, EXIT_SECONDS * 1000)
  }, [phase, schedule])

  if (phase === 'closed') return null

  return (
    <div className="thread-disclosure" data-open={phase === 'open' ? 'true' : 'false'} inert={!isOpen}>
      <div className="thread-disclosure__inner">{children}</div>
    </div>
  )
}
