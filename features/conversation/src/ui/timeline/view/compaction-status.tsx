import './compaction-status.css'
import './flow-row.css'
import './ticker/shimmer.css'
import './tools/tool-call.css'

import { cn, useCopy } from '@poietica/design-system'
import { Prose } from '@poietica/design-system/prose'
import { formatTokens } from '../../shared/model/usage'
import { DisclosureBody } from '../../shared/primitives/disclosure'
import { CheckIcon, ChevronDownIcon, CompactionIcon, CopyIcon } from '../../shared/primitives/icons'
import type { CompactionTimelineItem } from '../../shared/timeline/timeline-contract'

/** 前后两个数都有：「39.9K → 23.7K」；只有压缩前的、或都没有：null（由调用方另说） */
function spanOf(item: CompactionTimelineItem): string | null {
  if (item.tokensBefore === undefined || item.tokensAfter === undefined) return null
  return `${formatTokens(item.tokensBefore)} → ${formatTokens(item.tokensAfter)}`
}

/** 做完那一句：有前后两个数就带上，只有压缩前的就在括号里说原来多少 */
function completedOf(item: CompactionTimelineItem): string {
  const head = item.handoff === true ? '已交接' : '上下文已压缩'
  const span = spanOf(item)
  if (span !== null) return item.handoff === true ? `${head} · 上下文 ${span}` : `${head} ${span}`
  return item.tokensBefore === undefined ? head : `${head}（原 ${formatTokens(item.tokensBefore)}）`
}

function labelOf(item: CompactionTimelineItem): string {
  const handoff = item.handoff === true
  switch (item.state) {
    case 'completed':
      return completedOf(item)
    case 'blocked':
      return '等当前回复结束后压缩上下文'
    case 'cancelled':
      return handoff ? '已取消交接' : '已取消压缩'
    case 'failed':
      return handoff ? '交接失败' : '上下文压缩失败'
    case 'running':
      return handoff ? '正在生成交接文档…' : '正在压缩上下文…'
  }
}

/** 摘要是写给模型看的（多半是英文）：默认收着，展开先一句话说清它现在的作用，再给原文 */
function captionOf(item: CompactionTimelineItem): string | null {
  if (item.superseded === true) return '这份摘要已被后一次压缩取代。'
  if (item.summary === undefined) return null
  return item.handoff === true ? '之后的对话以这份交接文档为上下文继续。' : '较早的对话已替换为这份摘要。'
}

/** 展开那一面除摘要以外的几句：失败原因、事后告警、人给的要求 */
function notesOf(item: CompactionTimelineItem): string | null {
  const parts = [
    item.error,
    item.warning,
    item.instruction === undefined
      ? undefined
      : `${item.handoff === true ? '交接重点' : '压缩要求'}：${item.instruction}`,
  ].filter((part): part is string => part !== undefined && part !== '')

  return parts.length === 0 ? null : parts.join('\n\n')
}

/** 摘要原文与复制：被取代的那份只剩占位，不给复制 */
function SummaryBlock({ item }: { readonly item: CompactionTimelineItem }) {
  const { copied, copy } = useCopy()
  const caption = captionOf(item)
  const summary = item.superseded === true ? undefined : item.summary
  const noun = item.handoff === true ? '交接文档' : '摘要'

  if (caption === null) return null

  return (
    <>
      <div className="timeline-compaction__head">
        <span className="timeline-compaction__caption">{caption}</span>

        {summary === undefined ? null : (
          <button
            aria-label={copied ? `${noun}已复制` : `复制${noun}`}
            className="timeline-compaction__copy"
            data-copied={copied ? 'true' : undefined}
            onClick={() => copy(summary)}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        )}
      </div>

      {summary === undefined ? null : <Prose className="timeline-tool__prose" codeBlockMaxHeight={0} text={summary} />}
    </>
  )
}

/*
 * 与工具调用同一套行：字形 + 一句话 + 悬停才出现的箭头，跑着的时候那句话走同一道微光，抽屉同一个面板。
 * 默认收着，一行只说结果（「上下文已压缩 39.9K → 23.7K」）；摘要、交接文档、失败原因都在展开那一面。
 * 有东西可看才是按钮；什么都没有就只是一行状态，不给一个点了没反应的控件。
 */
export function CompactionStatus({
  isOpen,
  item,
  onToggle,
}: {
  readonly isOpen: boolean
  readonly item: CompactionTimelineItem
  readonly onToggle: () => void
}) {
  const notes = notesOf(item)
  const expandable = notes !== null || captionOf(item) !== null
  const content = (
    <>
      <CompactionIcon aria-hidden="true" className="timeline-row__icon" />

      <span className={cn('timeline-row__label', item.state === 'running' && 'timeline-shimmer')}>{labelOf(item)}</span>
    </>
  )

  if (!expandable) {
    return (
      <section className="timeline-tool" data-compaction={item.state}>
        <div className="timeline-row">{content}</div>
      </section>
    )
  }

  return (
    <section className="timeline-tool" data-compaction={item.state}>
      <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
        {content}

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-tool__body">
          <div className="timeline-tool__panel" data-scrollable="">
            {notes === null ? null : <p className="timeline-compaction__notes">{notes}</p>}

            <SummaryBlock item={item} />
          </div>
        </div>
      </DisclosureBody>
    </section>
  )
}
