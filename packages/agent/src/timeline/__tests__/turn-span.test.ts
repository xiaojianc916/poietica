import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '@poietica/agent-contract'
import { allItems } from '../timeline-contract'
import {
  appendUserMessage,
  applyRunEvents,
  createTimelineState,
  replayThreadEvents,
} from '../timeline-reducer'

/*
 * 一轮的两端，取自日志。
 *
 * 屏幕上那句「已处理 2m 28s」的两个端点就是这里的 startedAt 与 endedAt。它们必须来自
 * 帧里的 at —— 换成本机时钟，同一份日志在两台机器上会放出两个耗时。
 */

const started = (seq: number, at: number): RunEvent => ({
  kind: 'prompt_admitted',
  admissionId: 'adm',
  seq,
  at,
  sessionId: 'sess_span',
})

const finished = (seq: number, at: number): RunEvent => ({
  kind: 'run_finished',
  seq,
  at,
  stopReason: 'completed',
})

const crashed = (seq: number, at: number): RunEvent => ({
  kind: 'run_failed',
  seq,
  at,
  message: 'agent 掉线了',
})

describe('turn spans', () => {
  it('gives every turn its own two ends', () => {
    const state = replayThreadEvents([
      started(1, 1_000),
      finished(2, 89_000),
      started(1, 100_000),
      finished(2, 248_000),
    ])

    expect(state.spans.map((span) => [span.startedAt, span.endedAt])).toEqual([
      [1_000, 89_000],
      [100_000, 248_000],
    ])

    /* 段号从头正着数，所以首轮恒为 0（见 replayThreadEvents）。 */
    expect(state.spans.map((span) => span.turn)).toEqual([0, 1])
  })

  it('seals a turn that crashed', () => {
    const state = applyRunEvents(createTimelineState(), [started(1, 1_000), crashed(2, 4_500)])

    expect(state.spans.at(0)?.endedAt).toBe(4_500)
  })

  it('leaves a turn still running without an end', () => {
    const state = applyRunEvents(createTimelineState(), [started(1, 1_000)])

    expect(state.spans.at(0)?.startedAt).toBe(1_000)
    expect(state.spans.at(0)?.endedAt).toBeUndefined()
  })

  it('never moves an end once it is settled', () => {
    const state = applyRunEvents(createTimelineState(), [
      started(1, 1_000),
      finished(2, 89_000),
      /* 同一个 seq 是重复帧；随后那一帧是真的新帧，但这一轮已经落定了。 */
      finished(2, 120_000),
      crashed(3, 150_000),
    ])

    expect(state.spans).toHaveLength(1)
    expect(state.spans.at(0)?.endedAt).toBe(89_000)
  })

  it('keeps a log that never recorded a start out of it', () => {
    /* 进一条旧对话时看到的就是这个：没有起点，所以没有耗时可算，也就没有封条。 */
    const said = appendUserMessage(createTimelineState(), '上个月那条对话', 42_000)

    expect(said.spans).toEqual([])
    expect(allItems(said)).toHaveLength(1)
  })
})
