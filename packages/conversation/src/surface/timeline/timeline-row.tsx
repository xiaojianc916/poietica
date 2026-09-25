import './timeline.css'

import { memo } from 'react'
import type { FeedRow } from '../../timeline/presentation'
import { CompactionStatus } from './compaction-status'
import { ErrorNotice } from './error-notice'
import { LinkCard } from './link-card'
import { Prose } from './prose'
import { QuestionRecord } from './question-record'
import { ThoughtCard } from './thought-card'
import { ToolCallCard } from './tool-call-card'
import { UserMessage } from './user-message'

// 纯分发：feed 管滚动和测量，每个渲染器管自己的外观。
// 按 row memo，selector 保持条目身份稳定，到达的 token 只重渲尾部。
export interface TimelineRowProps {
  readonly row: FeedRow
  readonly isOpen: boolean
  // 收下 id 而不是闭包：这一支是 memo 过的，每帧换身份等于每帧重渲。
  readonly onToggle: (id: string) => void
}

export const TimelineRow = memo(function TimelineRow({ isOpen, onToggle, row }: TimelineRowProps) {
  const { item } = row

  switch (item.type) {
    case 'user_message':
      return (
        <UserMessage
          files={item.files}
          images={item.images}
          skills={item.skills}
          text={item.text}
        />
      )

    case 'agent_text':
      return <Prose className="timeline-message" streaming={row.isStreamingTail} text={item.text} />

    // 推理是一行现场：运行中不是控件，落定之后才交出开合。
    case 'agent_thought':
      return (
        <ThoughtCard
          isOpen={isOpen}
          isStreaming={row.isStreamingTail}
          onToggle={() => {
            onToggle(item.id)
          }}
          text={item.text}
        />
      )

    case 'tool_call':
      return (
        <ToolCallCard
          isInFlight={row.isInFlight}
          isOpen={isOpen}
          item={item}
          onToggle={() => {
            onToggle(item.id)
          }}
        />
      )

    case 'compaction':
      return <CompactionStatus item={item} />

    case 'error':
      return <ErrorNotice message={item.message} />

    case 'link':
      return (
        <LinkCard
          isInFlight={row.isInFlight}
          isOpen={isOpen}
          item={item}
          onToggle={() => {
            onToggle(item.id)
          }}
        />
      )

    case 'question':
      return <QuestionRecord item={item} />

    // 运行锚点只承载封条；审批与在飞身份不单独成行。
    case 'run_anchor':
    case 'inflight_prompt':
    case 'permission':
      return null

    default:
      return unhandled(item)
  }
})

function unhandled(_item: never): null {
  return null
}
