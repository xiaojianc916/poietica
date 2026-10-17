import { invariant } from '@poietica/foundation'
import { createContext, useContext } from 'react'

/**
 * 打开一条子代理通道（右坞「子代理」那一组里的一个标签）。`title` 是调用方手上已有的名字（状态面板那一行的描述）；
 * 缺席时由通道那一侧自己从转录里回查。由组合根提供；拿不到就是接线漏了。
 */
export type OpenDelegateChannel = (agentId: string, title?: string) => void

export const DelegateChannelContext = createContext<OpenDelegateChannel | null>(null)

export function useDelegateChannel(): OpenDelegateChannel {
  const open = useContext(DelegateChannelContext)

  if (open === null) {
    invariant(false, '这棵组件树上没有 DelegateChannelContext，派发通道无处可开。')
  }

  return open
}

/** 状态面板用：它也在没有组合根的夹具里单独画，拿不到就把那一行画成不可点。 */
export function useOptionalDelegateChannel(): OpenDelegateChannel | null {
  return useContext(DelegateChannelContext)
}
