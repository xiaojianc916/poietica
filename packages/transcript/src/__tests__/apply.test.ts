// 迁移自 legacy 对 applyOperation 语义的用例（11 页 P1.4）：输入改为新接口 applyOps，
// 断言意图一条不删；只测 AgentTranscript 类本身（监听器、roster）的用例不迁移。
import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, stateFromPage } from '../timeline'
import { frameId, stepId, turnId } from '../upstream/model/ids'
import type { StepHeader, TranscriptOperation, TurnHeader } from '../upstream/ops/operation'

const S1 = stepId(turnId(1), 1)
const turnHeader = (n: number): TurnHeader => ({
  kind: 'turn',
  turnId: turnId(n),
  ordinal: n,
  state: 'running',
  origin: { kind: 'other' },
})

describe('applyOps 语义', () => {
  test('一条轮按 ordinal 归位，乱序到达也如此', () => {
    const later = applyOps(emptyTimeline(), [{ op: 'turn.upsert', turn: turnHeader(2) }])
    const both = applyOps(later, [{ op: 'turn.upsert', turn: turnHeader(1) }])
    expect(both.items.map((i) => (i.kind === 'turn' ? i.turnId : '?'))).toEqual(['t1', 't2'])
  })

  test('step.upsert 在没有 turn 时补一个骨架轮', () => {
    const step: StepHeader = { kind: 'step', stepId: S1, turnId: turnId(1), ordinal: 1, state: 'running' }
    const state = applyOps(emptyTimeline(), [{ op: 'step.upsert', turnId: turnId(1), step }])
    expect(state.items.length).toBe(1)
    const turn = state.items[0]
    expect(turn?.kind === 'turn' && turn.steps.length === 1).toBe(true)
  })

  test('frame.upsert 在没有 step 时补一个骨架段', () => {
    const state = applyOps(emptyTimeline(), [
      {
        op: 'frame.upsert',
        turnId: turnId(1),
        stepId: S1,
        frame: { kind: 'thinking', frameId: frameId(S1, 1), text: '想' },
      },
    ])
    const turn = state.items[0]
    const text = turn?.kind === 'turn' ? turn.steps[0]?.frames[0] : undefined
    expect(text?.kind === 'thinking' && text.text === '想').toBe(true)
  })

  test('task.upsert + append 到 task 累积 outputTail', () => {
    const state = applyOps(emptyTimeline(), [
      { op: 'task.upsert', task: { taskId: 'k1', kind: 'shell', state: 'running', detached: false, outputTail: '' } },
      { op: 'append', target: { type: 'task', taskId: 'k1' }, offset: 0, text: 'a' },
      { op: 'append', target: { type: 'task', taskId: 'k1' }, offset: 1, text: 'b' },
    ])
    expect(state.tasks.get('k1')?.outputTail).toBe('ab')
  })

  test('items.remove 删掉条目', () => {
    const ops: TranscriptOperation[] = [{ op: 'turn.upsert', turn: turnHeader(1) }]
    const state = applyOps(emptyTimeline(), ops)
    const removed = applyOps(state, [{ op: 'items.remove', ids: [turnId(1)] }])
    expect(removed.items.length).toBe(0)
  })

  test('meta.merge 合并状态字段', () => {
    const state = applyOps(emptyTimeline(), [{ op: 'meta.merge', meta: { activity: 'turn' } }])
    expect(state.meta.activity).toBe('turn')
  })

  test('reset 覆盖整页并重建索引', () => {
    const page = {
      items: [turnHeader(1) as never],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: true,
    }
    const state = stateFromPage(page)
    expect(state.turnIndex.get('t1')).toBe(0)
    expect(state.hasMoreOlder).toBe(true)
    expect(pageFromState(state).items.length).toBe(1)
  })
})
