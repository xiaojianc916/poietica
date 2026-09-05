import type { TimelineItem, TimelineState, ToolCallTimelineItem } from './timeline-contract'

/**
 * 派发通道的寻址。
 *
 * 官方 transcript 自带 agentId（TranscriptPage.agents、ops 的 agent_id），通道
 * 的分流由 transcript 通道完成；这里只剩通道的命名与回查：子代理的流挂在
 * 派发它的那次调用下面，屏幕上因此没有第二种画法。
 */

/** 派发通道键的分隔符：对话号在前，子代理号在后。 */
const CHANNEL_MARK = '#'

/** 这条通道的转录键。子代理挂在派发它的那条对话下面。 */
export function delegateKey(conversation: string, agentId: string): string {
  return conversation + CHANNEL_MARK + agentId
}

/** 这个键是一条通道，不是一条对话。与 delegateKey 同住一处。 */
export interface DelegateAddress {
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

export function isDelegateKey(key: string): boolean {
  return delegateAddress(key) !== null
}

/** 开出过通道的调用就是一次派发。 */
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

/** 派出这个子代理的那次调用；找不到就是它不属于这条对话。活动段先找。 */
export function delegationOf(
  state: TimelineState,
  agentId: string,
): ToolCallTimelineItem | undefined {
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

/** 这条通道的名字。 */
export function channelNameOf(
  call: ToolCallTimelineItem | undefined,
  agentId: string,
): string | undefined {
  return call?.channels.find((one) => one.agentId === agentId)?.name
}
