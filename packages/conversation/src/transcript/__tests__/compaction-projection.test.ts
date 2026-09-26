import { describe, expect, it } from 'bun:test'
import type { AgentTranscriptSnapshot, TranscriptMarker } from '@poietica/transcript'
import { activeScope } from '../../timeline/timeline-queries'
import { projectTranscript } from '../transcript-projector'

/*
 * 上下文压缩那一行。
 *
 * 缘起：CompactionStatus 这个渲染器早就画好了（timeline-row.tsx:65-66），而没有任何东西
 * 产得出 `type: 'compaction'` 的条目 —— 屏幕上因此从不出现「上下文被压缩了」这一行，
 * 人看到的是自己前几句莫名其妙没了。
 *
 * 桥现在在 compaction 标记上带 payload（agent 自己报的），这里钉的是「它上得了屏」：
 * 标记 → 活动段的一行 → 渲染器读的那几格。
 */

const snapshot = (items: AgentTranscriptSnapshot['items']): AgentTranscriptSnapshot => ({
  items,
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
})

const marker = (markerId: string, payload: unknown): TranscriptMarker => ({
  kind: 'marker',
  markerId,
  marker: 'compaction',
  at: '2026-09-26T00:00:00.000Z',
  payload,
})

const compactionItems = (items: AgentTranscriptSnapshot['items']) =>
  activeScope(projectTranscript(snapshot(items))).items.filter((item) => item.type === 'compaction')

describe('上下文压缩那一行', () => {
  it('一次进行中的压缩上得了屏', () => {
    const rows = compactionItems([marker('c1', { state: 'running' })])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'compaction', id: 'c1', state: 'running' })
  })

  it('收尾之后那一行换状态，不是多出一行', () => {
    // 同一个号：压缩的开门与关门是同一行的两次 upsert（桥按号覆盖）。
    const rows = compactionItems([
      marker('c1', { state: 'completed', tokensBefore: 100, tokensAfter: 40 }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'completed', tokensBefore: 100, tokensAfter: 40 })
  })

  it('取消与阻塞各报各的状态，不都当成完成', () => {
    for (const state of ['cancelled', 'blocked'] as const) {
      const rows = compactionItems([marker(`c-${state}`, { state })])

      expect(rows[0]).toMatchObject({ state })
    }
  })

  it('数字缺席就不编：渲染器会退成一句没有数字的话', () => {
    const rows = compactionItems([marker('c1', { state: 'completed' })])

    // 缺席是缺席，不是 0 —— 报 0 会让人以为压缩把上下文清空了。
    expect(rows[0]).not.toHaveProperty('tokensBefore')
    expect(rows[0]).not.toHaveProperty('tokensAfter')
  })

  it('认不出的状态按「正在跑」处理，不谎报完成', () => {
    const rows = compactionItems([marker('c1', { state: 'something-new' })])

    // 报完成会把一次没成的压缩说成成了；报「正在跑」最多是暂时不准。
    expect(rows[0]).toMatchObject({ state: 'running' })
  })

  it('别的标记不上屏，也不冒充压缩', () => {
    const rows = compactionItems([
      { kind: 'marker', markerId: 'n1', marker: 'notice' },
      { kind: 'marker', markerId: 'u1', marker: 'undo' },
    ])

    expect(rows).toEqual([])
  })

  it('没有标记时不多出任何一行', () => {
    expect(compactionItems([])).toEqual([])
  })
})
