import { describe, expect, test } from 'bun:test'
import { compactionMarkerPayload } from '../model/compaction'

describe('压缩标记载荷', () => {
  test('读回落盘那份的摘要与用量', () => {
    expect(
      compactionMarkerPayload({
        state: 'completed',
        method: 'handoff',
        summary: '整份摘要',
        shortSummary: '短摘要',
        tokensBefore: 100,
        tokensAfter: 40,
      }),
    ).toEqual({
      state: 'completed',
      method: 'handoff',
      summary: '整份摘要',
      shortSummary: '短摘要',
      tokensBefore: 100,
      tokensAfter: 40,
    })
  })

  test('认不出的状态按「正在跑」处理', () => {
    expect(compactionMarkerPayload({ state: 'blocked' })).toEqual({ state: 'running' })
  })

  test('单个字段坏掉只丢那一格，不丢整条记录', () => {
    expect(compactionMarkerPayload({ state: 'failed', tokensBefore: -1, error: 'boom' })).toEqual({
      state: 'failed',
      error: 'boom',
    })
  })

  test('不是对象、或缺状态，仍交一个可画的状态', () => {
    expect(compactionMarkerPayload(undefined)).toEqual({ state: 'running' })
    expect(compactionMarkerPayload('nonsense')).toEqual({ state: 'running' })
  })
})
