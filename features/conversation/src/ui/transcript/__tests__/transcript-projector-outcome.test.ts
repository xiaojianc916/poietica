import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../agent/transcript'
import { createProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 轮的终局（omp 的 state）要一路走到封条那一格：它是「怎么结束的」唯一的事实来源，
 * 封条的三档文案与「折不折」全靠它。快照没报终局时不许自己编一个。
 */

const AT = '2026-10-10T00:00:00.000Z'

function opsFor(tag: string, state: string): unknown[] {
  const turnId = `${tag}-t1`
  const stepId = `${turnId}:s0`
  const ended = state === 'running' || state === 'queued' ? {} : { endedAt: AT }
  return [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal: 1,
        state,
        origin: { kind: 'user' },
        prompt: '问一句',
        startedAt: AT,
        ...ended,
      },
    },
    {
      op: 'step.upsert',
      turnId,
      step: { kind: 'step', stepId, turnId, ordinal: 0, state, startedAt: AT, ...ended },
    },
    {
      op: 'frame.upsert',
      turnId,
      stepId,
      frame: { kind: 'text', frameId: `${stepId}:f0`, role: 'assistant', text: '答一句' },
    },
  ]
}

function pageOf(state: ReturnType<typeof emptyTimeline>): TranscriptPage {
  return {
    ...state,
    tasks: [],
    interactions: [],
    prompts: [],
    attachments: [],
    markers: [],
    meta: {},
  } as unknown as TranscriptPage
}

function outcomeOfTurn(state: string): string | undefined {
  const snapshot = pageOf(applyOps(emptyTimeline(), opsFor('t', state) as TranscriptOperation[]))
  const timeline = projectTranscript(snapshot, createProjectionMemo())

  return timeline.sealed.at(-1)?.outcome ?? timeline.active.outcome
}

test('答完那一轮：completed', () => {
  expect(outcomeOfTurn('completed')).toBe('completed')
})

test('被人叫停那一轮：aborted（封条要报「已停止」）', () => {
  expect(outcomeOfTurn('cancelled')).toBe('aborted')
})

test('自己坏了那一轮：error（封条要报「处理失败」）', () => {
  expect(outcomeOfTurn('failed')).toBe('error')
})

test('还在跑 / 排队：没有终局，也不许编一个', () => {
  expect(outcomeOfTurn('running')).toBeUndefined()
  expect(outcomeOfTurn('queued')).toBeUndefined()
})

test('终局跟着页走：封口之后仍在那一页上，不靠再次投影补', () => {
  const snapshot = pageOf(
    applyOps(emptyTimeline(), [
      ...opsFor('a', 'completed'),
      ...opsFor('b', 'failed'),
    ] as unknown as TranscriptOperation[]),
  )
  const timeline = projectTranscript(snapshot, createProjectionMemo())

  expect(timeline.sealed.map((page) => page.outcome)).toEqual(['completed'])
  expect(timeline.active.outcome).toBe('error')
})
