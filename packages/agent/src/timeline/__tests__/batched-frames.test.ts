import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { allItems } from '../timeline-contract'
import { applyRunEvents, createTimelineState } from '../timeline-reducer'

/*
 * 分批是 applyRunEvents 存在的全部理由：上游按屏幕的节拍攒帧，一拍一趟草稿。于是
 * 「一条工具卡片在第二拍里还认不认得自己」这件事，全压在「下标一旦记下就不再移动」
 * 这一条不变式上。它不成立，第二拍的更新就会落到别的条目上，或者凭空多出一张卡。
 */

const opened = (seq: number): RunEvent => ({
  kind: 'kap_event',
  seq,
  at: seq,
  payload: { type: 'tool.call.started', toolCallId: 'call_1', name: '读文件' },
})

const progressed = (seq: number, text: string): RunEvent => ({
  kind: 'kap_event',
  seq,
  at: seq,
  payload: { type: 'tool.progress', toolCallId: 'call_1', update: { text } },
})

const spoke = (seq: number, text: string): RunEvent => ({
  kind: 'kap_event',
  seq,
  at: seq,
  payload: { type: 'assistant.delta', delta: text },
})

describe('分批喂帧', () => {
  it('分几批喂和一批喂完，转录逐字相同', () => {
    const events = [opened(1), progressed(2, 'a'), progressed(3, 'b'), spoke(4, '好')]
    const once = applyRunEvents(createTimelineState(), events)

    let split = createTimelineState()

    for (const event of events) {
      split = applyRunEvents(split, [event])
    }

    expect(allItems(split)).toEqual(allItems(once))
    expect(split.lastSeq).toBe(once.lastSeq)
    expect(split.status).toBe(once.status)
  })

  /* 上一批推进去的那一条，下一批必须认得出来 —— 认不出就会有两张卡。 */
  it('后一批的产出落回同一张卡，不另开一条', () => {
    const first = applyRunEvents(createTimelineState(), [opened(1), progressed(2, 'a')])
    const second = applyRunEvents(first, [progressed(3, 'b')])
    const card = allItems(second).at(0)

    expect(allItems(second)).toHaveLength(1)
    expect(card?.type === 'tool_call' && card.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'a' } },
      { type: 'content', content: { type: 'text', text: 'b' } },
    ])
  })

  /* 一份状态被开两次草稿：第二趟从零重建索引，两趟都必须定位到同一张卡。 */
  it('同一份状态被接着写两次，两次都定位得对', () => {
    const held = applyRunEvents(createTimelineState(), [opened(1), progressed(2, 'a')])
    const left = applyRunEvents(held, [progressed(3, '左')])
    const right = applyRunEvents(held, [progressed(3, '右')])
    const one = allItems(left).at(0)
    const other = allItems(right).at(0)

    expect(allItems(left)).toHaveLength(1)
    expect(allItems(right)).toHaveLength(1)
    expect(one?.type === 'tool_call' && one.content).toHaveLength(2)
    expect(other?.type === 'tool_call' && other.content).toHaveLength(2)
  })
})
