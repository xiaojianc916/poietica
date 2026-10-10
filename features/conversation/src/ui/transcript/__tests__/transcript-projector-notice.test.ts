import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../agent/transcript'
import { projectTranscript } from '../transcript-projector'

/*
 * notice 帧的级别要一路带到时间线条目（R-09）。
 *
 * 引擎侧已经不发 info，但投影器不能把漏网的那一条画成报错：info 投影成 null，
 * warning / error 各带自己的级别交给组件选样子。
 */

const AT = '2026-10-10T00:00:00.000Z'

function pageWith(level: 'info' | 'warning' | 'error'): TranscriptPage {
  const ops = [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user' },
        prompt: '发一句',
        startedAt: AT,
        endedAt: AT,
      },
    },
    {
      op: 'step.upsert',
      turnId: 't1',
      step: { kind: 'step', stepId: 't1:s0', turnId: 't1', ordinal: 0, state: 'completed', startedAt: AT, endedAt: AT },
    },
    {
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1:s0',
      frame: { kind: 'notice', frameId: 't1:s0:f0', level, message: 'm', source: 'omp' },
    },
  ] as unknown as TranscriptOperation[]
  const state = applyOps(emptyTimeline(), ops)
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

function errorItemsOf(level: 'info' | 'warning' | 'error') {
  return projectTranscript(pageWith(level)).active.items.filter((item) => item.type === 'error')
}

test('U1 info 不进时间线（不画成报错）', () => {
  expect(errorItemsOf('info')).toEqual([])
})

test('U2 warning 带级别进时间线', () => {
  const items = errorItemsOf('warning')
  expect(items.length).toBe(1)
  expect(items[0]?.level).toBe('warning')
  expect(items[0]?.message).toBe('m')
})

test('U3 error 带级别进时间线', () => {
  const items = errorItemsOf('error')
  expect(items.length).toBe(1)
  expect(items[0]?.level).toBe('error')
})
