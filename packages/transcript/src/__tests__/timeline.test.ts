import { describe, expect, test } from 'bun:test'
import type { TranscriptFrame } from '../model/frame'
import { frameId, stepId, turnId } from '../model/ids'
import type { StepHeader, TranscriptOperation, TurnHeader } from '../ops/operation'
import {
  applyOps,
  emptyTimeline,
  oldestTurnId,
  pageFromState,
  prependOlder,
  stateFromPage,
  TranscriptGapError,
  type TranscriptPage,
  transcriptOperationSchema,
  transcriptPageSchema,
} from '../timeline'

const APPROVAL = { toolName: 'bash', title: '允许使用工具：bash', detail: 'Command: ls', allowSessionScope: true }
const PLAN = { title: '迁移测试', planFilePath: 'local://migrate-plan.md', planMarkdown: '# 计划' }

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

  test('TL-5b 前半批合法、后半批缺口：整批作废，输入状态原样不动（副本据此不做回滚，P-02）', () => {
    const state = applyOps(emptyTimeline(), [...skeleton(1), appendTo(1, 0, 'Hel')])
    const before = pageFromState(state)
    expect(() => applyOps(state, [appendTo(1, 3, 'lo'), appendTo(1, 99, 'x')])).toThrow(TranscriptGapError)
    expect(pageFromState(state)).toEqual(before)
    expect(textOf(state, 1)).toBe('Hel')
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
    const current = pageFromState(applyOps(emptyTimeline(), skeleton(2)))
    const older: TranscriptPage = {
      ...emptyPage(),
      items: [turnHeader(1) as never, turnHeader(2) as never],
      hasMoreOlder: true,
    }
    const merged = prependOlder(current, older)
    expect(merged.items.map((i) => (i.kind === 'turn' ? i.turnId : '?'))).toEqual(['t1', 't2'])
    /* t2 用当前页那一份（带着 step），不是 older 里的空轮头 */
    expect(merged.items[1]).toBe(current.items[0])
    expect(oldestTurnId(stateFromPage(merged))).toBe('t1')
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
    const current = { ...emptyPage(), tasks: [task('completed')] }
    const older = { ...emptyPage(), tasks: [task('running')] }
    expect(prependOlder(current, older).tasks.map((t) => t.state)).toEqual(['completed'])
  })

  test('TL-9 pending 交互往返后仍在 pendingInteractions 里', () => {
    const state = applyOps(emptyTimeline(), [
      {
        op: 'interaction.upsert',
        interaction: { interactionId: 'i1', interactionKind: 'approval', state: 'pending', request: APPROVAL },
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

  /* 词表里的两个字段在**线上 schema** 里也必须活着：zod 默认剥掉未知键，只改类型不改 schema 会在收端静默丢号。 */
  test('TL-12 clientTurnId 与 plan 交互过 schema 不被剥掉、不被拒', () => {
    const upsert = { op: 'turn.upsert', turn: { ...turnHeader(1), clientTurnId: 'c-1' } }
    expect(transcriptOperationSchema.parse(upsert)).toEqual(upsert as TranscriptOperation)
    const plan = {
      op: 'interaction.upsert',
      interaction: { interactionId: 'p1', interactionKind: 'plan', state: 'pending', request: PLAN },
    } as const
    expect(transcriptOperationSchema.safeParse(plan).success).toBe(true)
    const page = { ...emptyPage(), interactions: [plan.interaction] }
    expect(transcriptPageSchema.safeParse(page).success).toBe(true)
    const state = applyOps(emptyTimeline(), [upsert as TranscriptOperation])
    const first = pageFromState(state).items[0]
    expect(first?.kind === 'turn' ? first.clientTurnId : null).toBe('c-1')
  })

  /*
   * 载荷按种类判别（Q1-C）：三种卡片连同答复过 schema 原样往返；形状不对的在收端就被拒，而不是让界面去猜。
   * 轮头的旧形状（`payload: unknown`）只会被剥成光秃秃的来源 —— 轮头与交互都不落盘，每次都从引擎重投影，
   * 所以没有要迁移的存量，只有「新收端遇到旧发端」这一种降级，而协议版本号把它挡在握手那一步。
   */
  test('TL-13 交互载荷与轮头来源按种类判别，过 schema 不丢格', () => {
    const cards = [
      {
        interactionId: 'a1',
        interactionKind: 'approval',
        state: 'approved',
        request: APPROVAL,
        response: { decision: 'approve', scope: 'session' },
      },
      {
        interactionId: 'p1',
        interactionKind: 'plan',
        state: 'answered',
        request: PLAN,
        response: { decision: 'revise', feedback: '先拆小' },
      },
      {
        interactionId: 'q1',
        interactionKind: 'question',
        state: 'answered',
        request: {
          questions: [
            {
              id: 'q0',
              prompt: '用哪个？',
              multiple: false,
              allowCustom: true,
              options: [
                { id: 'o0', label: 'bun', description: '快' },
                { id: 'o1', label: 'node' },
              ],
            },
          ],
        },
        response: { answers: { q0: { selected: ['o0'] } } },
      },
    ] as const
    for (const interaction of cards) {
      const op = { op: 'interaction.upsert', interaction }
      expect(transcriptOperationSchema.parse(op)).toEqual(op as TranscriptOperation)
    }
    const untyped = {
      op: 'interaction.upsert',
      interaction: { interactionId: 'x', interactionKind: 'approval', state: 'pending', request: { tool: 'bash' } },
    }
    expect(transcriptOperationSchema.safeParse(untyped).success).toBe(false)
    const skilled = { ...turnHeader(1), origin: { kind: 'user', skillActivations: [{ skillName: 'review' }] } }
    expect(transcriptOperationSchema.parse({ op: 'turn.upsert', turn: skilled })).toEqual({
      op: 'turn.upsert',
      turn: skilled,
    } as TranscriptOperation)
    const legacy = {
      ...turnHeader(1),
      origin: { kind: 'other', payload: { kind: 'system_trigger', name: 'goal_continuation' } },
    }
    const parsed = transcriptOperationSchema.parse({ op: 'turn.upsert', turn: legacy })
    expect(parsed.op === 'turn.upsert' ? parsed.turn.origin : null).toEqual({ kind: 'other' })
  })
})
