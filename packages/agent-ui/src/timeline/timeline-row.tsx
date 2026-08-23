import './timeline.css'

import type { FeedRow } from '@poietica/agent'
import { memo } from 'react'
import { ErrorNotice } from './error-notice'
import { PlanPanel } from './plan-panel'
import { Prose } from './prose'
import { QuestionRecord } from './question-record'
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
 * 上屏的条目类型各一支，一个分发点。新增一种在这里是编译错误，不是一行静默
 * 的空白。
 */
export interface TimelineRowProps {
  readonly row: FeedRow
}

export const TimelineRow = memo(function TimelineRow({ row }: TimelineRowProps) {
  const { item } = row

  switch (item.type) {
    case 'user_message':
      return <UserMessage images={item.images} skills={item.skills} text={item.text} />

    case 'agent_text':
      return (
        <Prose className="timeline-message" isStreaming={row.isStreamingTail} text={item.text} />
      )

    /* 推理与回答同一条 markdown 管线，音量由 timeline-thought 分开。 */
    case 'agent_thought':
      return (
        <Prose
          className="timeline-message timeline-thought"
          isStreaming={row.isStreamingTail}
          text={item.text}
        />
      )

    case 'tool_call':
      return <ToolCallCard isInFlight={row.isInFlight} item={item} />

    case 'plan':
      return <PlanPanel entries={item.entries} />

    case 'error':
      return <ErrorNotice message={item.message} />

    case 'question':
      return <QuestionRecord item={item} />

    /* 审批从不成行（renderable 把它挡在 feed 外）；这一支只为穷尽联合而存在。 */
    case 'permission':
      return null

    default:
      return unhandled(item)
  }
})

/* A new entry type fails to compile here; at runtime, nothing is drawn. */
function unhandled(_item: never): null {
  return null
}
