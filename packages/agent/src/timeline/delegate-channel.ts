import type { RunEvent } from '@poietica/agent-contract'

import type { TimelineItem, TimelineState, ToolCallTimelineItem } from './timeline-contract'

/**
 * 派发通道的寻址。
 *
 * 子代理的帧与主代理的帧同走一条会话、同一条 seq 线，区别只在帧上的 agentId。所以
 * 这里只做一件事：按号把一批帧分开，让每条流各进自己的转录 —— 投影、归并与渲染
 * 全部沿用主转录那一条管线，屏幕上因此没有第二种画法。
 */

/** 主代理的号。kap 给每一帧盖章，不报号的帧只可能来自它。 */
const MAIN_AGENT = 'main'

/** 通道键的分隔符：对话号在前，子代理号在后。 */
const CHANNEL_MARK = '#'

/** 载荷是索引签名，键只能走变量（见 kap-projection 的 fieldOf）。 */
const AGENT_KEY = 'agentId'

const NO_CHANNELS: ReadonlyMap<string, readonly RunEvent[]> = new Map()

/** 这条通道的转录键。子代理挂在派发它的那条对话下面。 */
export function delegateKey(conversation: string, agentId: string): string {
  return conversation + CHANNEL_MARK + agentId
}

/** 这个键是一条通道，不是一条对话。与 delegateKey 同住一处。 */
export function isDelegateKey(key: string): boolean {
  return key.includes(CHANNEL_MARK)
}

function agentOf(event: RunEvent): string {
  if (event.kind !== 'kap_event') {
    return MAIN_AGENT
  }

  const stamped = event.payload[AGENT_KEY]

  return typeof stamped === 'string' && stamped !== '' ? stamped : MAIN_AGENT
}

/**
 * 一批帧按号分流。
 *
 * 一批全是主代理的帧时原样交回入参那个数组：那是绝大多数情形，引用不变，下游的
 * 记忆化不被白白打掉。
 */
export function partitionByAgent(events: readonly RunEvent[]): {
  readonly main: readonly RunEvent[]
  readonly channels: ReadonlyMap<string, readonly RunEvent[]>
} {
  let main: RunEvent[] | undefined
  let channels: Map<string, RunEvent[]> | undefined

  for (const [index, event] of events.entries()) {
    const agentId = agentOf(event)

    if (agentId === MAIN_AGENT) {
      main?.push(event)

      continue
    }

    main ??= events.slice(0, index)
    channels ??= new Map()

    const held = channels.get(agentId)

    if (held === undefined) {
      channels.set(agentId, [event])
    } else {
      held.push(event)
    }
  }

  return main === undefined || channels === undefined
    ? { channels: NO_CHANNELS, main: events }
    : { channels, main }
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
