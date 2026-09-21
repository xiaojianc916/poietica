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

  /* turnIndex 是 items 的派生。增量路上每插入一条 turn 都要更新它，漏一次就再也找不到那条 turn。 */
  test('乱序到达的 turn 仍能按 ordinal 归位，且每条都找得到', () => {
    const live = new AgentTranscript('main')
    for (const ordinal of [3, 1, 2]) {
      const id = `t${ordinal}`
      live.receive([
        {
          op: 'turn.upsert',
          turn: { kind: 'turn', turnId: id, ordinal, state: 'running', origin: { kind: 'user' } },
        },
      ])
    }

    expect(live.getItems().map((item) => (item.kind === 'turn' ? item.turnId : item.kind))).toEqual(
      ['t1', 't2', 't3'],
    )
    for (const ordinal of [1, 2, 3]) {
      expect(live.getTurn(`t${ordinal}`)?.ordinal).toBe(ordinal)
    }
  })

  /* 删掉一条 turn 之后，后面那条的下标要跟着挪，否则 getTurn 会指到别人身上。 */
  test('删掉中间的 turn 之后，剩下的 turn 仍按下标找得到', () => {
    const live = new AgentTranscript('main')
    for (const ordinal of [1, 2, 3]) {
      const id = `t${ordinal}`
      live.receive([
        {
          op: 'turn.upsert',
          turn: { kind: 'turn', turnId: id, ordinal, state: 'running', origin: { kind: 'user' } },
        },
      ])
    }

    live.receive([{ op: 'items.remove', ids: ['t1'] }])

    expect(live.getTurn('t1')).toBeUndefined()
    expect(live.getTurn('t2')?.ordinal).toBe(2)
    expect(live.getTurn('t3')?.ordinal).toBe(3)
  })
})
