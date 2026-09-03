import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '../../agent'
import { selectPresentation } from '../presentation'
import { applyRunEvents, createTimelineState } from '../timeline-reducer'

/*
 * 派生视图的引用稳定性。
 *
 * 下游按行对象的身份记忆化，所以「已收口的行在流式期间引用不动」是正确性契约，
 * 不是性能观察：它一破，每来一段文字整屏都要重画。
 */

const CLOSED: ReadonlyMap<number, boolean> = new Map()

const asked = (seq: number): RunEvent => ({
  kind: 'prompt_admitted',
  admissionId: 'adm',
  seq,
  at: seq,
  sessionId: 'sess_stable',
  prompt: '核对一遍构建命令',
})

const spoke = (seq: number, delta: string): RunEvent => ({
  kind: 'kap_event',
  seq,
  at: seq,
  payload: { type: 'assistant.delta', delta },
})

const finished = (seq: number): RunEvent => ({
  kind: 'run_finished',
  seq,
  at: seq,
  stopReason: 'completed',
})

describe('selectPresentation 的引用稳定性', () => {
  it('同一份状态取两次视图，行对象逐个同一', () => {
    const state = applyRunEvents(createTimelineState(), [asked(1), spoke(2, '好'), finished(3)])
    const once = selectPresentation(state, CLOSED)
    const twice = selectPresentation(state, CLOSED)

    expect(once.count).toBeGreaterThan(0)
    expect(twice.count).toBe(once.count)

    for (let row = 0; row < once.count; row += 1) {
      expect(Object.is(twice.rowAt(row), once.rowAt(row))).toBe(true)
    }
  })

  /* 头两帧那一轮还在成形，从第三帧起首行必须一动不动。 */
  it('流式期间首行引用不动', () => {
    let state = applyRunEvents(createTimelineState(), [
      asked(1),
      spoke(2, '第一段'),
      spoke(3, '第二段'),
    ])
    const settled = selectPresentation(state, CLOSED).rowAt(0)

    for (let frame = 0; frame < 8; frame += 1) {
      state = applyRunEvents(state, [spoke(4 + frame, '再一段')])

      expect(Object.is(selectPresentation(state, CLOSED).rowAt(0), settled)).toBe(true)
    }
  })

  it('运行中不物化回复操作，收口后文本保持完整', () => {
    let state = applyRunEvents(createTimelineState(), [
      asked(1),
      spoke(2, '第一段'),
      spoke(3, '第二段'),
    ])
    const running = selectPresentation(state, CLOSED)

    for (let row = 0; row < running.count; row += 1) {
      expect(running.replyAt(row)).toBeUndefined()
    }

    state = applyRunEvents(state, [finished(4)])
    const settled = selectPresentation(state, CLOSED)
    const replies = Array.from({ length: settled.count }, (_, row) => settled.replyAt(row)).filter(
      (reply) => reply !== undefined,
    )

    expect(replies).toHaveLength(1)
    expect(replies[0]?.text).toBe('第一段第二段')
  })

  it('新一轮到达时视图变长，旧行仍是原来那一个', () => {
    const before = applyRunEvents(createTimelineState(), [asked(1), spoke(2, '好'), finished(3)])
    const rows = selectPresentation(before, CLOSED)
    const kept = rows.rowAt(0)
    const after = applyRunEvents(before, [asked(4), spoke(5, '再好')])
    const grown = selectPresentation(after, CLOSED)

    expect(grown.count).toBeGreaterThan(rows.count)
    expect(Object.is(grown.rowAt(0), kept)).toBe(true)
  })
})
