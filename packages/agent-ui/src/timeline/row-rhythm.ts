import type { FeedRow } from '@poietica/agent'
import type { RowRhythm } from '../feed/agent-activity-feed'

/*
 * 一行按哪一档节奏排：左图标右文字的一条记事（glyph），或一段正文（prose）。
 *
 * 表的键就是条目类型的联合，与 row-estimate.ts 同一条约束：新增一个类型在这里编译失败，
 * 而不是安静地按正文那一档排。
 */
const RHYTHM: Record<FeedRow['item']['type'], RowRhythm> = {
  agent_text: 'prose',
  agent_thought: 'glyph',
  error: 'prose',
  /* 与 permission 同理：它从不成行。 */
  inflight_prompt: 'prose',
  link: 'glyph',
  permission: 'prose',
  plan: 'prose',
  question: 'prose',
  tool_call: 'glyph',
  user_message: 'prose',
}

export function rowRhythmOf(row: FeedRow | undefined): RowRhythm {
  const item = row?.item

  return item === undefined ? 'prose' : RHYTHM[item.type]
}
