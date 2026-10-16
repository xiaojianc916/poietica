import './flow-row.css'
import './ticker/shimmer.css'
import './tools/tool-call.css'

import { cn } from '@poietica/design-system'
import { Prose } from '@poietica/design-system/prose'
import { DisclosureBody } from '../../shared/primitives/disclosure'
import { ChevronDownIcon, CompactionIcon } from '../../shared/primitives/icons'
import type { CompactionTimelineItem } from '../../shared/timeline/timeline-contract'

const COUNT = new Intl.NumberFormat()

function count(value: number): string {
  return COUNT.format(value)
}

function labelOf(item: CompactionTimelineItem): string {
  switch (item.state) {
    case 'completed':
      if (item.tokensBefore !== undefined && item.tokensAfter !== undefined) {
        return `已压缩上下文 · ${count(item.tokensBefore)} → ${count(item.tokensAfter)} tokens`
      }
      return item.tokensBefore === undefined ? '已压缩上下文' : `已压缩上下文 · 原 ${count(item.tokensBefore)} tokens`
    case 'blocked':
      return '上下文压缩正在等待当前轮次结束'
    case 'cancelled':
      return '上下文压缩已取消'
    case 'failed':
      return '上下文压缩失败'
    case 'running':
      return '正在压缩上下文…'
  }
}

/** 展开那一面：失败给原因，做完给摘要；被后一次压缩取代的那份只剩占位，照实说 */
function bodyOf(item: CompactionTimelineItem): string | null {
  const parts = [
    item.error,
    item.warning,
    item.superseded === true ? '这份摘要已被后一次压缩取代。' : item.summary,
    item.instruction === undefined ? undefined : `压缩要求：${item.instruction}`,
  ].filter((part): part is string => part !== undefined && part !== '')

  return parts.length === 0 ? null : parts.join('\n\n')
}

/*
 * 与工具调用同一套行：字形 + 一句话 + 悬停才出现的箭头，跑着的时候那句话走同一道微光，抽屉同一个面板。
 * 从前它是一行自绘的「↻ + 灰字」，与上下那几行工具调用两种长相（审查 R-21-3）。
 * 有摘要 / 原因可看才是按钮；什么都没有就只是一行状态，不给一个点了没反应的控件。
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
  const trigger = item.trigger === 'manual' ? '手动' : item.trigger === 'auto' ? '自动' : ''
  const label = trigger === '' ? labelOf(item) : `${labelOf(item)} · ${trigger}`
  const body = bodyOf(item)
  const content = (
    <>
      <CompactionIcon aria-hidden="true" className="timeline-row__icon" />

      <span className={cn('timeline-row__label', item.state === 'running' && 'timeline-shimmer')}>{label}</span>
    </>
  )

  if (body === null) {
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
            <Prose className="timeline-tool__prose" codeBlockMaxHeight={0} text={body} />
          </div>
        </div>
      </DisclosureBody>
    </section>
  )
}
