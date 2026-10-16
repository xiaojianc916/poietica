import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../agent/transcript'
import type { TimelineState } from '../../timeline/timeline-contract'
import { createProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 「从这里分叉」交给引擎的是这一轮的**轮号**（只留前 keepTurns 轮），不是界面从尾部数出来的「撤销几个用户锚点」。
 *
 * 旧做法要证明「尾部数出来的位置」与引擎那边数 role:user 的位置严格一致，证明不了就禁用：
 * 压缩过一次、用过一次技能、目标续跑过一轮，之前的轮就全都不能分叉。轮号是引擎签发的，
 * 实时与重开一致（R-27），这些情形都不需要再证明什么。
 */

const at = (second: number): string => new Date(Date.UTC(2026, 9, 10, 0, 0, second)).toISOString()

type Origin = { readonly kind: string; readonly payload?: unknown }

function turn(ordinal: number, origin: Origin, state = 'completed'): unknown[] {
  const turnId = `t${ordinal}`
  const stepId = `${turnId}:s0`
  return [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal,
        state,
        origin,
        prompt: origin.kind === 'user' ? `问 ${ordinal}` : undefined,
        startedAt: at(ordinal * 10),
        endedAt: state === 'completed' ? at(ordinal * 10 + 5) : undefined,
      },
    },
    {
      op: 'step.upsert',
      turnId,
      step: { kind: 'step', stepId, turnId, ordinal: 0, state, startedAt: at(ordinal * 10), endedAt: at(ordinal * 10) },
    },
    {
      op: 'frame.upsert',
      turnId,
      stepId,
      frame: { kind: 'text', frameId: `${stepId}:f0`, role: 'assistant', text: `答 ${ordinal}` },
    },
  ]
}

const compaction = (second: number): unknown => ({
  op: 'marker.upsert',
  item: {
    kind: 'marker',
    markerId: `c${second}`,
    marker: 'compaction',
    at: at(second),
    payload: { state: 'completed' },
  },
})

function pageOf(ops: readonly unknown[]): TranscriptPage {
  const state = applyOps(emptyTimeline(), ops as TranscriptOperation[])
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

function forkOf(state: TimelineState): (number | string)[] {
  return [...state.sealed, state.active].map((page) => page.run?.keepTurns ?? page.run?.forkUnavailableReason ?? '-')
}

test('K-1 每一轮的分叉位置就是它的轮号：压缩、技能、目标续跑之前的轮照样能分叉', () => {
  const state = projectTranscript(
    pageOf([
      ...turn(1, { kind: 'user' }),
      compaction(17),
      ...turn(2, { kind: 'user', payload: { skills: ['demo'] } }),
      ...turn(3, { kind: 'other' }),
      ...turn(4, { kind: 'user' }),
    ]),
    createProjectionMemo(),
  )
  expect(forkOf(state)).toEqual([1, 2, 3, 4])
})

test('K-2 会话还在跑：哪一轮都不分叉（磁盘上的会话还没写完），并说明原因', () => {
  const state = projectTranscript(
    pageOf([...turn(1, { kind: 'user' }), ...turn(2, { kind: 'user' }, 'running')]),
    createProjectionMemo(),
  )
  expect(forkOf(state)).toEqual(['会话仍在运行或等待输入，暂不可分叉。', '会话仍在运行或等待输入，暂不可分叉。'])
})
