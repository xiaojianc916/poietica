import './flow-row.css'

import { Prose } from '@poietica/design-system/prose'
import { FeatureScope, useContributions } from '@poietica/ui-kernel'
import { memo, Suspense } from 'react'
import { type ToolCallRendererProps, toolCallRenderers } from '../../../ui-api'
import type { TimelineItem } from '../../shared/timeline/timeline-contract'
import { type FeedRow, matchesToolName } from '../presentation'
import { CompactionStatus } from './compaction-status'
import { ErrorNotice } from './error-notice'
import { LinkCard } from './link-card'
import { RetryStatus } from './retry-status'
import { ToolCallCard } from './tools/tool-call-card'
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
 * 其它功能为自己的 agent 工具贡献卡片（toolCallRenderers）。
 * 匹配按 invokedTool（matchesToolName，与「内联」判据同一份）—— 它就是「真正在跑的是谁」，与字形、身份同一格。
 */

/** 时间线的四档状态 → 贡献点的三档（running/succeeded/failed）。 */
function rendererStatusOf(status: 'completed' | 'failed' | 'in_progress' | 'pending'): ToolCallRendererProps['status'] {
  if (status === 'completed') return 'succeeded'
  if (status === 'failed') return 'failed'
  return 'running'
}

/* 工具调用那一支单独成层：贡献者的查找与回退不占时间线分发的分支。 */
function ToolCallRow({
  isInFlight,
  isOpen,
  item,
  onToggle,
  threadId,
}: {
  readonly isInFlight: boolean
  readonly isOpen: boolean
  readonly item: Extract<TimelineItem, { readonly type: 'tool_call' }>
  readonly onToggle: (id: string) => void
  readonly threadId: string
}) {
  const renderers = useContributions(toolCallRenderers)
  const contributed = renderers.find((candidate) => matchesToolName(candidate.item.toolName, item.invokedTool))

  if (contributed !== undefined) {
    const Card = contributed.item.component

    return (
      <FeatureScope featureId={contributed.featureId}>
        {/* 贡献方可以按需加载（例如 browser 的工具卡）：本地兜底，别让整条时间线退成骨架屏。 */}
        <Suspense fallback={null}>
          <Card
            args={item.rawInput}
            argsStreaming={item.status === 'pending'}
            callId={item.toolCallId}
            result={item.rawOutput ?? null}
            status={rendererStatusOf(item.status)}
            threadId={threadId}
            toolName={item.invokedTool}
          />
        </Suspense>
      </FeatureScope>
    )
  }

  return (
    <ToolCallCard
      isInFlight={isInFlight}
      isOpen={isOpen}
      item={item}
      onToggle={() => {
        onToggle(item.id)
      }}
    />
  )
}

export const TimelineRow = memo(function TimelineRow({ isOpen, onToggle, row, threadId }: TimelineRowProps) {
  const { item } = row

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

    // 推理从不落成一行：它只在它那条过程组头上一闪（tool-group-card），这里没有它的位置。
    case 'agent_thought':
      return null

    case 'tool_call':
      return (
        <ToolCallRow isInFlight={row.isInFlight} isOpen={isOpen} item={item} onToggle={onToggle} threadId={threadId} />
      )

    case 'compaction':
      return (
        <CompactionStatus
          isOpen={isOpen}
          item={item}
          onToggle={() => {
            onToggle(item.id)
          }}
        />
      )

    case 'retry':
      return (
        <RetryStatus
          isOpen={isOpen}
          item={item}
          onToggle={() => {
            onToggle(item.id)
          }}
        />
      )

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
