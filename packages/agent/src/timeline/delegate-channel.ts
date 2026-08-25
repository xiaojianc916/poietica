import type { ToolCallContent } from '@poietica/agent-contract'

import {
  isTerminal,
  type TimelineItem,
  type TimelineState,
  type ToolCallTimelineItem,
} from './timeline-contract'

/**
 * 一次派发的通信通道。
 *
 * 子代理的帧不进主转录（kap-projection 的 agentId 闸门），它的账目属于派发它的
 * 那次工具调用 —— kap 按 toolCallId 寻址这次调用的进度与产出，所以那条条目就是
 * 这条通道的唯一事实来源。这里只投影，不存第二份。
 */

/** 通道里的一句话。 */
export interface DelegateMessage {
  readonly id: string
  readonly author: 'main' | 'delegate'
  readonly text: string
}

export interface DelegateChannelView {
  readonly toolCallId: string
  readonly title: string
  readonly isRunning: boolean
  readonly messages: readonly DelegateMessage[]
}

/** 有独立通道的两档：派一个子代理，或派一条后台任务。 */
export function isDelegation(item: ToolCallTimelineItem): boolean {
  return item.kind === 'delegate' || item.kind === 'task'
}

function findIn(
  items: readonly TimelineItem[],
  toolCallId: string,
): ToolCallTimelineItem | undefined {
  for (const item of items) {
    if (item.type === 'tool_call' && item.toolCallId === toolCallId && isDelegation(item)) {
      return item
    }
  }

  return undefined
}

/** 这条对话里的那一次派发；找不到就是它不属于这条对话。活动段先找。 */
export function delegationOf(
  state: TimelineState,
  toolCallId: string,
): ToolCallTimelineItem | undefined {
  const live = findIn(state.active.items, toolCallId)

  if (live !== undefined) {
    return live
  }

  for (let index = state.sealed.length - 1; index >= 0; index -= 1) {
    const page = state.sealed[index]
    const hit = page === undefined ? undefined : findIn(page.items, toolCallId)

    if (hit !== undefined) {
      return hit
    }
  }

  return undefined
}

/** 一段产出里的文字；空白与非文字都没有可读的一句。 */
function textOf(part: ToolCallContent): string | null {
  if (part.type !== 'content' || part.content.type !== 'text') {
    return null
  }

  return part.content.text.trim() === '' ? null : part.content.text
}

/** 交回来的那一份：逐段进度各算一句；只有整份产出时它自己算一句。 */
function repliesOf(item: ToolCallTimelineItem): DelegateMessage[] {
  const said: DelegateMessage[] = []

  for (let index = 0; index < item.content.length; index += 1) {
    const part = item.content[index]
    const text = part === undefined ? null : textOf(part)

    if (text !== null) {
      said.push({ id: `${item.toolCallId}:d${String(index)}`, author: 'delegate', text })
    }
  }

  if (said.length === 0 && typeof item.rawOutput === 'string' && item.rawOutput.trim() !== '') {
    said.push({ id: `${item.toolCallId}:d0`, author: 'delegate', text: item.rawOutput })
  }

  return said
}

/** 这次派发在屏幕上是一段对话：先是我说的那一句，然后是它交回来的。 */
export function delegateChannel(item: ToolCallTimelineItem): DelegateChannelView {
  const asked = item.subject.trim() === '' ? item.title : item.subject

  return {
    toolCallId: item.toolCallId,
    title: item.title,
    isRunning: !isTerminal(item.status),
    messages: [{ id: `${item.toolCallId}:m`, author: 'main', text: asked }, ...repliesOf(item)],
  }
}
