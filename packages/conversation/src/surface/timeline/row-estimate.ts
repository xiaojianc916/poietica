import type { FeedRow } from '../../timeline/presentation'

// 首屏估高：条目类型是现成信息，用一个常量估所有类型是白白放弃它。
// 表键是条目类型联合，新增类型会在这里和 timeline-row.tsx 同时编译失败。
const ROW_PX: Record<Exclude<FeedRow['item']['type'], 'agent_text'>, number> = {
  agent_thought: 32,
  compaction: 32,
  error: 96,
  inflight_prompt: 0,
  link: 32,
  permission: 0,
  question: 96,
  tool_call: 32,
  run_anchor: 32,
  user_message: 72,
}

// 行高正本：--ui-prose-size(0.875rem) × --ui-prose-line-height(1.65) = 23.1px，向上取整到 24。
// 逻辑行数是下界（软换行只会让真高更大）。
const PROSE_BASE_PX = 28
const PROSE_LINE_PX = 24

const MISSING_PX = 120

interface ProseMeasurement {
  readonly length: number
  readonly lines: number
}

export type RowEstimator = (row: FeedRow | undefined) => number

// 同一正文 id 只追加；每次估高只扫描本帧新增的后缀。
export function createRowEstimator(): RowEstimator {
  const measurements = new Map<string, ProseMeasurement>()

  return (row) => {
    const item = row?.item

    if (item === undefined) {
      return MISSING_PX
    }
    if (item.type !== 'agent_text') {
      return ROW_PX[item.type]
    }

    const previous = measurements.get(item.id)
    const appendFrom =
      previous !== undefined && previous.length <= item.text.length ? previous.length : 0
    let lines = appendFrom === 0 ? 1 : (previous?.lines ?? 1)

    for (
      let cursor = item.text.indexOf('\n', appendFrom);
      cursor >= 0;
      cursor = item.text.indexOf('\n', cursor + 1)
    ) {
      lines += 1
    }

    measurements.set(item.id, { length: item.text.length, lines })
    return PROSE_BASE_PX + lines * PROSE_LINE_PX
  }
}
