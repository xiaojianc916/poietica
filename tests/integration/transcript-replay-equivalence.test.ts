import { describe, expect, test } from 'bun:test'
import { projectTranscript } from '@poietica/conversation'
import {
  AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@poietica/transcript'

/*
 * 官方 transcript 通道的等价不变量：同一份经过，逐条增量喂给 reducer，
 * 与 reset 一次成型，投影出来的时间线必须一字不差。
 *
 * 屏幕那一侧走 ops 增量（TranscriptStore 的 #signal），重开一条对话走
 * readTranscript 的快照（#install 的 reset）—— 两条路落到的必须是同一条
 * 时间线，否则重开一条对话会看到另一副样子。
 */

const TURN = 't1'
const STEP = 's1'
const FRAME = 'f1'

const turn = {
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: TURN, ordinal: 1, state: 'running', origin: { kind: 'user' } },
} satisfies TranscriptOperation

const step = {
  op: 'step.upsert',
  turnId: TURN,
  step: { kind: 'step', stepId: STEP, turnId: TURN, ordinal: 1, state: 'completed' },
} satisfies TranscriptOperation

const _frame = (text: string, offset: number) =>
  ({
    op: 'frame.upsert',
    turnId: TURN,
    stepId: STEP,
    frame: { kind: 'text', frameId: FRAME, role: 'assistant', text },
    ...(offset > 0
      ? {
          op: 'append',
          target: { type: 'frame', turnId: TURN, stepId: STEP, frameId: FRAME },
          offset,
          text,
        }
      : {}),
  }) as TranscriptOperation

describe('官方 transcript 的增量与一次成型等价', () => {
  test('同一份经过，两条路投影出同一条时间线', () => {
    const ops: readonly TranscriptOperation[] = [
      turn,
      step,
      {
        op: 'frame.upsert',
        turnId: TURN,
        stepId: STEP,
        frame: { kind: 'text', frameId: FRAME, role: 'assistant', text: '你' },
      },
      {
        op: 'append',
        target: { type: 'frame', turnId: TURN, stepId: STEP, frameId: FRAME },
        offset: 1,
        text: '好',
      },
    ]

    const streamed = new AgentTranscript('main')
    for (const one of ops) {
      streamed.receive([one])
    }

    const snapshot: AgentTranscriptSnapshot = {
      items: [
        {
          kind: 'turn',
          turnId: TURN,
          ordinal: 1,
          state: 'running',
          origin: { kind: 'user' },
          steps: [
            {
              kind: 'step',
              stepId: STEP,
              turnId: TURN,
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: FRAME, role: 'assistant', text: '你好' }],
            },
          ],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: false,
    }

    const replayed = new AgentTranscript('main')
    replayed.receive([{ op: 'reset', agentId: 'main', snapshot }])

    expect(projectTranscript(streamed.snapshot())).toEqual(projectTranscript(replayed.snapshot()))
  })
})
