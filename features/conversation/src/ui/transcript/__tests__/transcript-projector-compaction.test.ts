import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../agent/transcript'
import type { TimelineState } from '../../timeline/timeline-contract'
import { createProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 压缩那一行在屏幕上的位置（审查 R-21-1）。
 *
 * 从前所有压缩标记一律挂在活动段尾部：完整经过里压过好几次，它们会全挤在最后一轮末尾，
 * 而且离开了它们真正发生的位置。现在：条目序里它前面最近的那一轮收下它，页内按时刻插在
 * 它之后才开始的第一条之前。
 */

const at = (second: number): string => new Date(Date.UTC(2026, 9, 10, 0, 0, second)).toISOString()

function turn(ordinal: number, steps: readonly { readonly second: number; readonly text: string }[]): unknown[] {
  const turnId = `t${ordinal}`
  return [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal,
        state: 'completed',
        origin: { kind: 'user' },
        prompt: `问 ${ordinal}`,
        startedAt: at(steps[0]?.second ?? 0),
        endedAt: at(59),
      },
    },
    ...steps.flatMap((step, index) => {
      const stepId = `${turnId}:s${index}`
      return [
        {
          op: 'step.upsert',
          turnId,
          step: {
            kind: 'step',
            stepId,
            turnId,
            ordinal: index,
            state: 'completed',
            startedAt: at(step.second),
            endedAt: at(step.second),
          },
        },
        {
          op: 'frame.upsert',
          turnId,
          stepId,
          frame: { kind: 'text', frameId: `${stepId}:f0`, role: 'assistant', text: step.text },
        },
      ]
    }),
  ]
}

function compaction(markerId: string, second: number, payload: Record<string, unknown>): unknown {
  return { op: 'marker.upsert', item: { kind: 'marker', markerId, marker: 'compaction', at: at(second), payload } }
}

function pageOf(ops: readonly unknown[]): TranscriptPage {
  return pageOfState(applyOps(emptyTimeline(), ops as TranscriptOperation[]))
}

function pageOfState(state: ReturnType<typeof emptyTimeline>): TranscriptPage {
  return {
    ...state,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
    agentId: 'main',
    agents: [],
    pendingInteractions: [],
    seq: 1,
  } as unknown as TranscriptPage
}

/** 每一页的条目：`<页的轮号>:<类型>[:正文 / 压缩号]` */
function rowsOf(state: TimelineState): string[] {
  return [...state.sealed, state.active].flatMap((page) =>
    page.items.map((item) => {
      if (item.type === 'agent_text') return `${page.turn}:${item.text}`
      if (item.type === 'compaction') return `${page.turn}:compaction:${item.id}`
      return `${page.turn}:${item.type}`
    }),
  )
}

test('C1 两次压缩各落在自己那一轮里，不全挤到最后一轮末尾', () => {
  const state = projectTranscript(
    pageOf([
      ...turn(1, [{ second: 1, text: '答 1' }]),
      compaction('compaction-1-1', 5, { state: 'completed' }),
      ...turn(2, [{ second: 10, text: '答 2' }]),
      ...turn(3, [{ second: 20, text: '答 3' }]),
    ]),
    createProjectionMemo(),
  )
  expect(rowsOf(state)).toEqual([
    '1:user_message',
    '1:答 1',
    '1:compaction:compaction-1-1',
    '2:user_message',
    '2:答 2',
    '3:user_message',
    '3:答 3',
  ])
})

test('C2 一轮中途压缩：压缩之后才开始的段排在它下面', () => {
  const state = projectTranscript(
    pageOf([
      ...turn(1, [
        { second: 1, text: '压缩前' },
        { second: 9, text: '压缩后' },
      ]),
      compaction('compaction-live-1', 5, { state: 'running' }),
    ]),
    createProjectionMemo(),
  )
  expect(rowsOf(state)).toEqual(['1:user_message', '1:压缩前', '1:compaction:compaction-live-1', '1:压缩后'])
})

test('C3 载荷一路带到条目：token 数、短摘要优先、失败原因、被取代', () => {
  const state = projectTranscript(
    pageOf([
      ...turn(1, [{ second: 1, text: '答' }]),
      compaction('a', 2, {
        state: 'completed',
        tokensBefore: 120_000,
        tokensAfter: 18_000,
        summary: '整份',
        shortSummary: '短的',
      }),
      compaction('b', 3, { state: 'failed', error: '没有模型' }),
      compaction('c', 4, { state: 'completed', superseded: true }),
    ]),
    createProjectionMemo(),
  )
  const items = state.active.items.filter((item) => item.type === 'compaction')
  expect(items).toMatchObject([
    { id: 'a', state: 'completed', tokensBefore: 120_000, tokensAfter: 18_000, summary: '短的' },
    { id: 'b', state: 'failed', error: '没有模型' },
    { id: 'c', state: 'completed', superseded: true },
  ])
})

test('C4 封了口的那一页：标记没变就复用同一个页对象（presentation 的前缀缓存靠它）', () => {
  const memo = createProjectionMemo()
  const ops = [
    ...turn(1, [{ second: 1, text: '答 1' }]),
    compaction('compaction-1-1', 5, { state: 'completed' }),
    ...turn(2, [{ second: 10, text: '答 2' }]),
  ]
  const base = applyOps(emptyTimeline(), ops as TranscriptOperation[])
  const first = projectTranscript(pageOfState(base), memo)
  // 在跑的第二轮再吐一个字：上游结构共享，第一轮与那条标记都还是原来的对象
  const streamed = applyOps(base, [
    {
      op: 'frame.upsert',
      turnId: 't2',
      stepId: 't2:s0',
      frame: { kind: 'text', frameId: 't2:s0:f0', role: 'assistant', text: '答 2 多一个字' },
    },
  ] as unknown as TranscriptOperation[])
  const again = projectTranscript(pageOfState(streamed), memo)
  expect(first.sealed.length).toBe(1)
  expect(again.sealed).toBe(first.sealed)
})

test('C5 一轮都还没有：压缩那一行照样上屏', () => {
  const state = projectTranscript(
    pageOf([compaction('compaction-live-1', 1, { state: 'running' })]),
    createProjectionMemo(),
  )
  expect(rowsOf(state)).toEqual(['0:compaction:compaction-live-1'])
})
