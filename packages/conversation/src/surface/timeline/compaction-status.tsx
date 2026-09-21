import './compaction-status.css'

import type { CompactionTimelineItem } from '../../timeline/timeline-contract'

/* 一行里最多两个数，但组件会随流式重绘；格式器建一次就够。 */
const COUNT = new Intl.NumberFormat()

function count(value: number): string {
  return COUNT.format(value)
}

export function CompactionStatus({ item }: { readonly item: CompactionTimelineItem }) {
  const trigger = item.trigger === 'manual' ? '手动' : item.trigger === 'auto' ? '自动' : ''
  const label =
    item.state === 'completed' && item.tokensBefore !== undefined && item.tokensAfter !== undefined
      ? '上下文压缩完成（' +
        count(item.tokensBefore) +
        ' → ' +
        count(item.tokensAfter) +
        ' tokens）'
      : item.state === 'blocked'
        ? '上下文压缩正在等待当前轮次结束'
        : item.state === 'cancelled'
          ? '上下文压缩已取消'
          : '正在压缩上下文…'

  return (
    <div className="compaction-status" data-state={item.state}>
      <span aria-hidden="true" className="compaction-status__icon">
        ↻
      </span>
      <span>{trigger === '' ? label : `${label} · ${trigger}`}</span>
    </div>
  )
}
