import type { FeedRow } from '../../timeline/presentation'
import type { RowRhythm } from '../feed/agent-activity-feed'

// 表键是条目类型联合，与 row-estimate.ts 同一条约束：新增类型在这里编译失败。
const RHYTHM: Record<FeedRow['item']['type'], RowRhythm> = {
  agent_text: 'prose',
  agent_thought: 'glyph',
  compaction: 'glyph',
  error: 'prose',
  inflight_prompt: 'prose',
  link: 'glyph',
  permission: 'prose',
  question: 'prose',
  tool_call: 'glyph',
  run_anchor: 'prose',
  user_message: 'prose',
}

export function rowRhythmOf(row: FeedRow | undefined): RowRhythm {
  const item = row?.item

  return item === undefined ? 'prose' : RHYTHM[item.type]
}
