import './timeline.css'

import { FeatureScope, useContributions } from '@poietica/ui-kernel'
import { memo } from 'react'
import { type ToolCallRendererProps, toolCallRenderers } from '../../../ui-api'
import type { FeedRow } from '../../timeline/presentation'
import { CompactionStatus } from './compaction-status'
import { ErrorNotice } from './error-notice'
import { LinkCard } from './link-card'
import { Prose } from './prose'
import { ThoughtCard } from './thought-card'
import { ToolCallCard } from './tool-call-card'
import { UserMessage } from './user-message'

// 纯分发：feed 管滚动和测量，每个渲染器管自己的外观。
// 按 row memo，selector 保持条目身份稳定，到达的 token 只重渲尾部。
export interface TimelineRowProps {
  readonly row: FeedRow
  /** 这条时间线属于哪条线程：贡献工具卡片的渲染器要它。 */
  readonly threadId: string
  readonly isOpen: boolean
  // 收下 id 而不是闭包：这一支是 memo 过的，每帧换身份等于每帧重渲。
  readonly onToggle: (id: string) => void
}

/*
 * 其它功能为自己的 agent 工具贡献卡片（07 页 §5E 的 toolCallRenderers）。
 * 匹配按 invokedTool —— 它就是「真正在跑的是谁」，与字形、身份同一格。
 */
function matchesToolName(toolName: string | RegExp, invokedTool: string): boolean {
  return typeof toolName === 'string'
    ? toolName === invokedTool
    : new RegExp(toolName.source, toolName.flags).test(invokedTool)
}

/** 时间线的四档状态 → 贡献点的三档（running/succeeded/failed）。 */
function rendererStatusOf(status: 'completed' | 'failed' | 'in_progress' | 'pending'): ToolCallRendererProps['status'] {
  if (status === 'completed') return 'succeeded'
  if (status === 'failed') return 'failed'
  return 'running'
}

export const TimelineRow = memo(function TimelineRow({ isOpen, onToggle, row, threadId }: TimelineRowProps) {
  const { item } = row
  const renderers = useContributions(toolCallRenderers)

  switch (item.type) {
    case 'user_message':
      return (
        <UserMessage
          files={item.files}
          images={item.images}
          skills={item.skills}
          text={item.text}
          undelivered={item.undelivered}
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

    case 'tool_call': {
      const contributed = renderers.find((candidate) => matchesToolName(candidate.item.toolName, item.invokedTool))

      if (contributed !== undefined) {
        const Card = contributed.item.component

        return (
          <FeatureScope featureId={contributed.featureId}>
            <Card
              args={item.rawInput}
              result={item.rawOutput ?? null}
              status={rendererStatusOf(item.status)}
              threadId={threadId}
              toolName={item.invokedTool}
            />
          </FeatureScope>
        )
      }

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
    }

    case 'compaction':
      return <CompactionStatus item={item} />

    case 'error':
      return <ErrorNotice level={item.level} message={item.message} />

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

    // 运行锚点只承载封条；提问的答复长在发起它的那次调用里，审批与在飞身份不单独成行。
    case 'run_anchor':
    case 'inflight_prompt':
    case 'permission':
    case 'plan':
    case 'question':
      return null

    default:
      return unhandled(item)
  }
})

function unhandled(_item: never): null {
  return null
}
