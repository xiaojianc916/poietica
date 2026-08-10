import './timeline.css'

import type { FeedRow } from '@poietica/agent'
import { memo } from 'react'
import { ErrorNotice } from './error-notice'
import { PermissionRecord } from './permission-record'
import { PlanPanel } from './plan-panel'
import { Prose } from './prose'
import { ReasoningPanel } from './reasoning-panel'
import { ToolCallCard } from './tool-call-card'
import { UserMessage } from './user-message'

/**
 * One entry in the activity feed.
 *
 * Dispatch only. The feed owns scrolling and measurement, each renderer owns
 * its own appearance, and this decides nothing except which one applies.
 *
 * Memoised against the row, whose identity the selector holds stable for as
 * long as its entry is untouched: an arriving token then re-renders the tail
 * and nothing above it.
 *
 * 七个条目类型，七个 case，一个分发点。
 *
 * 这里不再接会话。审批已经搬去输入框上方那条带子 —— 转录里的权限那一支现在
 * 只回答「这条记录要不要留个影」，不回答「批不批」，所以那个用来答复的参数
 * 连同它的引用稳定性要求一起走了。
 *
 * 一个新的条目类型在这里是编译错误，不是一行静默的空白。
 */
export interface TimelineRowProps {
  readonly row: FeedRow
}

export const TimelineRow = memo(function TimelineRow({ row }: TimelineRowProps) {
  const { item } = row

  switch (item.type) {
    case 'user_message':
      return <UserMessage images={item.images} text={item.text} />

    case 'agent_text':
      return (
        <Prose className="timeline-message" isStreaming={row.isStreamingTail} text={item.text} />
      )

    case 'agent_thought':
      return <ReasoningPanel isStreaming={row.isStreamingTail} text={item.text} />

    case 'tool_call':
      return <ToolCallCard isInFlight={row.isInFlight} item={item} />

    case 'plan':
      return <PlanPanel entries={item.entries} />

    case 'error':
      return <ErrorNotice message={item.message} />

    case 'permission':
      return <PermissionRecord item={item} />

    default:
      return unhandled(item)
  }
})

/* A new entry type fails to compile here; at runtime, nothing is drawn. */
function unhandled(_item: never): null {
  return null
}
