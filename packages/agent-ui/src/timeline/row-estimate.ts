import type { FeedRow } from '@poietica/agent'
import { countLines } from './split-stream'

/*
 * 首屏估高。
 *
 * 估值只在一行被真正测量之前使用，但它决定测量那一刻的落差：落差越大，虚拟器要补的
 * 滚动增量越大，也越容易被人眼看见，而每一次补偿又会挂载新的行去测。条目类型是现成
 * 的信息，用一个常量估所有类型是白白放弃它。
 *
 * 表的键就是条目类型的联合：timeline-row.tsx 末尾那个 unhandled(_item: never) 已经
 * 证过那个 switch 穷尽，新增一个类型会在这两处同时编译失败。
 */
const ROW_PX: Record<Exclude<FeedRow['item']['type'], 'agent_text'>, number> = {
  agent_thought: 40,
  error: 96,
  permission: 0,
  plan: 200,
  question: 96,
  tool_call: 40,
  user_message: 72,
}

/*
 * 正文按内容估：一句「好的」与一段两千行的回答不是同一个高度。
 *
 * 行高的正本在 packages/ui/src/styles/tokens/typography.css：--ui-prose-size
 *（0.875rem）× --ui-prose-line-height（1.65）= 23.1px，而 timeline.css 的
 * .timeline-prose 逐字消费这两个令牌。这里向上取整到 24，因此不小于一行的实际行盒。
 *
 * 逻辑行数是下界（软换行只会让真高更大），所以这两个数是下界，不是猜测。
 */
const PROSE_BASE_PX = 28
const PROSE_LINE_PX = 24

/* 下标越界：这一行不存在。类型联合已由上面那张表穷尽，这不是「未知类型」的估高。 */
const MISSING_PX = 120

export function estimateRowPx(row: FeedRow | undefined): number {
  const item = row?.item

  if (item === undefined) {
    return MISSING_PX
  }

  return item.type === 'agent_text'
    ? PROSE_BASE_PX + countLines(item.text) * PROSE_LINE_PX
    : ROW_PX[item.type]
}
