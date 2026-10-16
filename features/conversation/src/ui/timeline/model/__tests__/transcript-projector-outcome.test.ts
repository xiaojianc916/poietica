import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { selectPresentation } from '../../presentation'
import { createProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 轮的终局（omp 的 state）要一路走到封条那一格：它是「怎么结束的」唯一的事实来源，
 * 封条的三档文案与「折不折」全靠它。快照没报终局时不许自己编一个。
 *
 * 后半段钉「中途插话」这条判据的**真实来路**：插话在投影里就是一条 user_message，
 * 而它出现的位置决定那一轮折不折 —— 判据必须是端到端的，不是照着一个手搓数组猜的。
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

/* 一轮：开场白 + 用户步骤 + 一个 read 调用 + 答复；`interjection` 非空时在同一轮里再插一句人话。 */
function interjectedPage(interjection: string | null): TranscriptPage {
  const turnId = 't1'
  const opener = `${turnId}:s0`
  const step = `${turnId}:s1`
  const ops: unknown[] = [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user' },
        prompt: '打底',
        startedAt: AT,
        endedAt: AT,
      },
    },
    {
      op: 'step.upsert',
      turnId,
      step: { kind: 'step', stepId: opener, turnId, ordinal: 0, state: 'completed', startedAt: AT, endedAt: AT },
    },
    {
      op: 'step.upsert',
      turnId,
      step: { kind: 'step', stepId: step, turnId, ordinal: 1, state: 'completed', startedAt: AT, endedAt: AT },
    },
    {
      op: 'frame.upsert',
      turnId,
      stepId: step,
      frame: {
        kind: 'tool',
        frameId: `${step}:t0`,
        name: 'read',
        toolCallId: 'c1',
        input: {},
        output: '',
        state: 'done',
      },
    },
    {
      op: 'frame.upsert',
      turnId,
      stepId: step,
      frame: { kind: 'text', frameId: `${step}:f0`, role: 'assistant', text: '看完了。' },
    },
  ]
  if (interjection !== null) {
    /* 插话带 origin: user —— 引擎只在**真的插话**时给这一格（开场那条用户帧没有）。 */
    ops.push({
      op: 'frame.upsert',
      turnId,
      stepId: step,
      frame: { kind: 'text', frameId: `${step}:f9`, role: 'user', text: interjection, origin: { kind: 'user' } },
    })
  }
  return pageOf(applyOps(emptyTimeline(), ops as TranscriptOperation[]))
}

function feedOf(page: TranscriptPage) {
  return selectPresentation(projectTranscript(page, createProjectionMemo()), new Map())
}

function sealOfFeed(feed: ReturnType<typeof feedOf>) {
  for (let index = 0; index < feed.count; index += 1) {
    const seal = feed.sealAt(index)

    if (seal !== undefined) {
      return seal
    }
  }

  return undefined
}

describe('中途插话：判据走真实投影，不是照着数组猜', () => {
  test('插过话的那一轮不折：过程里夹着人自己的话', () => {
    expect(sealOfFeed(feedOf(interjectedPage('插一句')))?.canCollapse).toBe(false)
  })

  test('没插过话的那一轮照常可折', () => {
    expect(sealOfFeed(feedOf(interjectedPage(null)))?.canCollapse).toBe(true)
  })

  test('插话那句话在投影里真的是一条 user_message，且在它的产出之后', () => {
    const feed = feedOf(interjectedPage('插一句'))
    const texts: string[] = []

    for (let index = 0; index < feed.count; index += 1) {
      const item = feed.rowAt(index)?.item

      if (item?.type === 'user_message') {
        texts.push(item.text)
      }
    }

    expect(texts).toEqual(['打底', '插一句'])
  })
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
