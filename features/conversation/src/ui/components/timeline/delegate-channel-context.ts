import { invariant } from '@poietica/foundation'
import { createContext, useContext } from 'react'

/* 由组合根提供；拿不到就是接线漏了。 */
export const DelegateChannelContext = createContext<((agentId: string) => void) | null>(null)

export function useDelegateChannel(): (agentId: string) => void {
  const open = useContext(DelegateChannelContext)

  if (open === null) {
    invariant(false, '这棵组件树上没有 DelegateChannelContext，派发通道无处可开。')
  }

  return open
}
