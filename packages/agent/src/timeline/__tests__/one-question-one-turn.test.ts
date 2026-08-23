import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { selectPresentation } from '../presentation'
import { allItems, type TimelineState } from '../timeline-contract'
import {
  appendUserMessage,
  applyRunEvent,
  createTimelineState,
  replayThreadEvents,
} from '../timeline-reducer'

/*
 * 一问一格。
 *
 * 缩略导航按「人问过几次」数格子（presentation 的轮次轨道），所以转录里
 * 多一条用户消息，轨道上就多一根杠。这里守的是「同一句话只落一次账」这条不变式，
 * 一句话的每一条到达路径各来一遍。
 */

const SHUT: ReadonlySet<string> = new Set()

function started(seq: number, prompt: string, images?: readonly string[]): RunEvent {
  return {
    kind: 'run_started',
    seq,
    at: seq,
    sessionId: 'sess',
    prompt,
    ...(images === undefined ? {} : { images }),
  }
}

function spoke(seq: number, text: string): RunEvent {
  return { kind: 'kap_event', seq, at: seq, payload: { type: 'assistant.delta', delta: text } }
}

function finished(seq: number): RunEvent {
  return { kind: 'run_finished', seq, at: seq, stopReason: 'completed' }
}

function said(state: TimelineState): readonly string[] {
  return allItems(state).flatMap((item) => (item.type === 'user_message' ? [item.text] : []))
}

function rails(state: TimelineState): number {
  return selectPresentation(state, SHUT).turns.length
}

describe('one question, one rail stop', () => {
  it('takes the local message and the recorded prompt as the same question', () => {
    const asked = appendUserMessage(createTimelineState(), '读取 README', 1)
    const running = applyRunEvent(asked, started(1, '读取 README'))
    const state = applyRunEvent(running, spoke(2, '好的，我看一下。'))

    expect(said(state)).toEqual(['读取 README'])
    expect(rails(state)).toBe(1)
  })

  it('takes a question asked mid-answer and its own run prompt as one question', () => {
    const asked = appendUserMessage(createTimelineState(), '第一个问题', 1)
    const running = applyRunEvent(asked, started(1, '第一个问题'))
    const answering = applyRunEvent(running, spoke(2, '好，'))

    /* 不等它答完就问下一句：这一轮不换段，那句话落在还在跑的这一段里。 */
    const inserted = appendUserMessage(answering, '第二个问题', 3)

    /* 上一轮的收尾把它挤离末尾 —— 比「末尾那一条」的判据就是在这里落空的。 */
    const trailing = applyRunEvent(inserted, spoke(3, '这是第一问的结尾。'))
    const closed = applyRunEvent(trailing, finished(4))
    const second = applyRunEvent(closed, started(1, '第二个问题'))

    expect(said(second)).toEqual(['第一个问题', '第二个问题'])
    expect(rails(second)).toBe(2)
  })

  it('still opens a message for a question that is nothing but a picture', () => {
    const state = replayThreadEvents([
      started(1, '第一个问题'),
      spoke(2, '好。'),
      finished(3),
      started(1, '', ['poietica-asset://asset/t/abc']),
      spoke(2, '看到了。'),
      finished(3),
    ])

    expect(said(state)).toEqual(['第一个问题', ''])
  })

  it('keeps the injected aside out of what the user is quoted as saying', () => {
    const state = replayThreadEvents([
      started(1, '看这张图<system-reminder>图片已被压缩</system-reminder>'),
      spoke(2, '看到了。'),
      finished(3),
    ])

    expect(said(state)).toEqual(['看这张图'])
  })
})
