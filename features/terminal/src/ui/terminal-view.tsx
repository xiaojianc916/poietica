import { cn } from '@poietica/design-system'
import { useEffect, useRef } from 'react'
import type { TerminalSession } from './terminal-sessions'

export interface TerminalViewProps {
  readonly session: TerminalSession
  /** 后台标签的画面留在 DOM 里但不可见，尺寸量不到；切回来时 ResizeObserver 再量一次。 */
  readonly active: boolean
}

/** 容器那一格、观察者与量尺寸的时机照 legacy 一字未改；只是 Terminal 对象不再由本组件创建 / 销毁 —— 它常驻在会话表里，本组件只管挂与量。 */
export function TerminalView({ session, active }: TerminalViewProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const wasActive = useRef(active)

  useEffect(() => {
    const element = host.current

    if (element === null) {
      return undefined
    }

    session.attach(element)

    const observer = new ResizeObserver(() => {
      session.scheduleFit()
    })

    observer.observe(element)
    session.scheduleFit()

    return () => {
      observer.disconnect()
      session.detach()
    }
  }, [session])

  /* 从后台切到前台才接焦点：点标签的那一刻画面还藏着（display:none 接不住焦点），得等这次提交把它亮出来。首次挂载不抢焦点 ——
   * 新开的终端在 PTY 接上时自己 focus，重载恢复出来的不该把焦点从输入框里拽走。 */
  useEffect(() => {
    if (active && !wasActive.current) {
      session.focus()
    }
    wasActive.current = active
  }, [active, session])

  return <div className={cn('h-full min-h-0 w-full', !active && 'hidden')} ref={host} />
}
