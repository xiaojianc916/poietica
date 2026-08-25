import { createContext, useContext } from 'react'

/*
 * 打开一条派发通道的能力，由组合根给。
 *
 * 与 transcripts-context 同一形制：导出 context 本体与读它的 hook，provider 就是
 * context。拿不到就是接线漏了，当场说出来。
 */
export const DelegateChannelContext = createContext<((toolCallId: string) => void) | null>(null)

export function useDelegateChannel(): (toolCallId: string) => void {
  const open = useContext(DelegateChannelContext)

  if (open === null) {
    throw new Error('这棵组件树上没有 DelegateChannelContext，派发通道无处可开。')
  }

  return open
}
