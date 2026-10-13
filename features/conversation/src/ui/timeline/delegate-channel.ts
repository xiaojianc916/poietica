import type { TimelineItem, TimelineState, ToolCallTimelineItem } from './timeline-contract'

/**
 * 派发通道的寻址：官方 transcript 自带 agentId（TranscriptPage.agents、ops 的 agent_id），通道的分流由 transcript 通道完成，
 * 这里只剩通道的命名与回查 —— 子代理的流挂在派发它的那次调用下面，屏幕上因此没有第二种画法。
 */
const CHANNEL_MARK = '#'

export function delegateKey(conversation: string, agentId: string): string {
  return conversation + CHANNEL_MARK + agentId
}

/** 这个键是一条通道，不是一条对话。与 delegateKey 同住一处。 */
interface DelegateAddress {
  readonly conversation: string
  readonly agentId: string
}

export function delegateAddress(key: string): DelegateAddress | null {
  const mark = key.indexOf(CHANNEL_MARK)
  if (mark <= 0 || mark === key.length - 1) {
    return null
  }
  return { conversation: key.slice(0, mark), agentId: key.slice(mark + 1) }
}

export function isDelegation(item: ToolCallTimelineItem): boolean {
  return item.channels.length > 0
}

function findIn(items: readonly TimelineItem[], agentId: string): ToolCallTimelineItem | undefined {
  for (const item of items) {
    if (item.type === 'tool_call' && item.channels.some((one) => one.agentId === agentId)) {
      return item
    }
  }

  return undefined
}

export function delegationOf(state: TimelineState, agentId: string): ToolCallTimelineItem | undefined {
  const live = findIn(state.active.items, agentId)

  if (live !== undefined) {
    return live
  }

  for (let index = state.sealed.length - 1; index >= 0; index -= 1) {
    const page = state.sealed[index]
    const hit = page === undefined ? undefined : findIn(page.items, agentId)

    if (hit !== undefined) {
      return hit
    }
  }

  return undefined
}

export function channelNameOf(call: ToolCallTimelineItem | undefined, agentId: string): string | undefined {
  return call?.channels.find((one) => one.agentId === agentId)?.name
}
