import { cn } from '@poietica/design-system'
import { useEffect, useRef } from 'react'
import type { TerminalSession } from './terminal-sessions'

export interface TerminalViewProps {
  readonly session: TerminalSession
  /** 后台标签的画面留在 DOM 里但不可见：尺寸量不到，切回来时 ResizeObserver 再量一次 */
  readonly active: boolean
}

/**
 * 一个终端的画布。**迁移自** legacy `packages/terminal/src/surface/terminal-pane.tsx`：
 * 容器那一格（`h-full min-h-0 w-full bg-background`）、观察者与量尺寸的时机一字未改，
 * 只是 Terminal 对象不再由本组件创建/销毁 —— 它常驻在会话表里，本组件只管挂与量。
 */
export function TerminalView({ session, active }: TerminalViewProps) {
  const host = useRef<HTMLDivElement | null>(null)

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

  return <div className={cn('h-full min-h-0 w-full bg-background', !active && 'hidden')} ref={host} />
}
