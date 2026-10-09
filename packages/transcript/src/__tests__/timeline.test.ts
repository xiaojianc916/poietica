import { describe, expect, test } from 'bun:test'
import {
  applyOps,
  emptyTimeline,
  oldestTurnId,
  pageFromState,
  prependOlder,
  stateFromPage,
  TranscriptGapError,
  type TranscriptPage,
  transcriptPageSchema,
} from '../timeline'
import type { TranscriptFrame } from '../upstream/model/frame'
import { frameId, stepId, turnId } from '../upstream/model/ids'
import type { StepHeader, TranscriptOperation, TurnHeader } from '../upstream/ops/operation'

const emptyPage = (): TranscriptPage => ({
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
})

const turnHeader = (n: number): TurnHeader => ({
  kind: 'turn',
  turnId: turnId(n),
  ordinal: n,
  state: 'running',
  origin: { kind: 'other' },
})

const S1 = stepId(turnId(1), 1)
const F1 = frameId(S1, 1)

/** turn → step → 空文本 frame 的骨架 op 序列 */
const skeleton = (n: number): TranscriptOperation[] => {
  const turn = turnId(n)
  const step = stepId(turn, 1)
  const stepHeader: StepHeader = { kind: 'step', stepId: step, turnId: turn, ordinal: 1, state: 'running' }
  const frame: TranscriptFrame = { kind: 'text', frameId: frameId(step, 1), text: '', role: 'assistant' }
  return [
    { op: 'turn.upsert', turn: turnHeader(n) },
    { op: 'step.upsert', turnId: turn, step: stepHeader },
    { op: 'frame.upsert', turnId: turn, stepId: step, frame },
  ]
}

const appendTo = (n: number, offset: number, text: string): TranscriptOperation => {
  const turn = turnId(n)
  const step = stepId(turn, 1)
  return {
    op: 'append',
    target: { type: 'frame', turnId: turn, stepId: step, frameId: frameId(step, 1) },
    offset,
    text,
  }
}

const textOf = (state: ReturnType<typeof emptyTimeline>, n: number): string => {
  const turn = state.items.find((item) => item.kind === 'turn' && item.turnId === turnId(n))
  if (turn === undefined || turn.kind !== 'turn') throw new Error('turn 不存在')
  const frame = turn.steps[0]?.frames[0]
  if (frame === undefined || (frame.kind !== 'text' && frame.kind !== 'thinking')) throw new Error('frame 不存在')
  return frame.text
}

describe('timeline', () => {
  test('TL-1 空页往返深相等', () => {
    const page = emptyPage()
    expect(pageFromState(stateFromPage(page))).toEqual(page)
  })

  test('TL-2 增量 append 拼出完整文本', () => {
    const state = applyOps(emptyTimeline(), [...skeleton(1), appendTo(1, 0, 'Hel'), appendTo(1, 3, 'lo')])
    expect(textOf(state, 1)).toBe('Hello')
  })

  test('TL-3 重复的 append 返回同一个对象', () => {
    const state = applyOps(emptyTimeline(), [...skeleton(1), appendTo(1, 0, 'Hel'), appendTo(1, 3, 'lo')])
    const again = applyOps(state, [appendTo(1, 0, 'Hel')])
    expect(again).toBe(state)
    expect(textOf(again, 1)).toBe('Hello')
  })

  test('TL-4 越界的 append 抛 TranscriptGapError', () => {
    const state = applyOps(emptyTimeline(), [...skeleton(1), appendTo(1, 0, 'Hel'), appendTo(1, 3, 'lo')])
    let caught: unknown
    try {
      applyOps(state, [appendTo(1, 9, 'x')])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TranscriptGapError)
    const gap = caught as TranscriptGapError
    expect(gap.expected).toBe(5)
    expect(gap.got).toBe(9)
    expect(gap.target?.type).toBe('frame')
  })

  test('TL-5 与已有内容冲突的 append 抛 TranscriptGapError', () => {
    const state = applyOps(emptyTimeline(), [...skeleton(1), appendTo(1, 0, 'Hel'), appendTo(1, 3, 'lo')])
    expect(() => applyOps(state, [appendTo(1, 2, 'Xyz')])).toThrow(TranscriptGapError)
  })

  test('TL-6 同一批 op 应用两次，状态幂等', () => {
    const ops: TranscriptOperation[] = [...skeleton(1), appendTo(1, 0, 'Hel'), appendTo(1, 3, 'lo')]
    const once = applyOps(emptyTimeline(), ops)
    const twice = applyOps(once, ops)
    // 内容幂等：重放同一批 op 不改变状态。frame.upsert 携带的是空文本快照，重放会重写那一格，
    // 所以这里是深相等；引用相等由下面“已落地批次”的用例保证。
    expect(twice).toEqual(once)
    expect(textOf(twice, 1)).toBe('Hello')
    // 批次里的 upsert 携带的就是已落地的内容时，整批都是 no-op，返回同一个对象
    const landed: TranscriptOperation[] = [
      skeleton(1)[0]!,
      skeleton(1)[1]!,
      {
        op: 'frame.upsert',
        turnId: turnId(1),
        stepId: S1,
        frame: { kind: 'text', frameId: F1, text: 'Hello', role: 'assistant' },
      },
      appendTo(1, 0, 'Hello'),
    ]
    const state = applyOps(emptyTimeline(), landed)
    expect(applyOps(state, landed)).toBe(state)
  })

  test('TL-7 prependOlder：更早的一页拼在前面，已有轮用当前版本', () => {
    const current = applyOps(emptyTimeline(), skeleton(2))
    const older: TranscriptPage = {
      ...emptyPage(),
      items: [turnHeader(1) as never, turnHeader(2) as never],
      hasMoreOlder: true,
    }
    const merged = prependOlder(current, older)
    expect(merged.items.map((i) => (i.kind === 'turn' ? i.turnId : '?'))).toEqual(['t1', 't2'])
    expect(oldestTurnId(merged)).toBe('t1')
    expect(merged.turnIndex.get('t2')).toBe(1)
    expect(merged.hasMoreOlder).toBe(true)
  })

  test('TL-8 prependOlder 侧表同 id 以当前状态为准', () => {
    const task = (state: 'running' | 'completed') => ({
      taskId: 'task1',
      kind: 'other' as const,
      state,
      detached: false,
      outputTail: '',
    })
    const current = stateFromPage({ ...emptyPage(), tasks: [task('completed')] })
    const older = { ...emptyPage(), tasks: [task('running')] }
    expect(prependOlder(current, older).tasks.get('task1')?.state).toBe('completed')
  })

  test('TL-9 pending 交互往返后仍在 pendingInteractions 里', () => {
    const state = applyOps(emptyTimeline(), [
      {
        op: 'interaction.upsert',
        interaction: { interactionId: 'i1', interactionKind: 'approval', state: 'pending' },
      },
    ])
    expect(pageFromState(state).interactions.length).toBe(1)
    expect(stateFromPage(pageFromState(state)).pendingInteractions.has('i1')).toBe(true)
  })

  test('TL-10 transcriptPageSchema 能解析 pageFromState 的结果', () => {
    const state = applyOps(emptyTimeline(), [...skeleton(1), appendTo(1, 0, 'hi')])
    expect(transcriptPageSchema.safeParse(pageFromState(state)).success).toBe(true)
  })

  test('TL-11 空时间线没有最早的轮', () => {
    expect(oldestTurnId(emptyTimeline())).toBeNull()
  })
})
