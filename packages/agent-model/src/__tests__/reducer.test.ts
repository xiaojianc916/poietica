import { describe, expect, test } from 'bun:test'
import { type AgentEvent, agentEventSchema, type CommittedAgentEvent, type ThreadSnapshot } from '../events'
import type { TranscriptFrame } from '../model/frame'
import { frameId, stepId, turnId } from '../model/ids'
import type { AgentState } from '../ops/apply'
import { EMPTY_THREAD_STATE, materialize, reduce, reduceAll, snapshotOf, stateFromSnapshot } from '../reducer'

const T1 = turnId(1)
const S1 = stepId(T1, 1)
const F1 = frameId(S1, 1)
const F2 = frameId(S1, 2)

const at = '2026-11-08T00:00:00.000Z'

const runStarted: CommittedAgentEvent = {
  type: 'run.started',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  run: {
    kind: 'turn',
    turnId: T1,
    ordinal: 1,
    state: 'running',
    origin: { kind: 'user' },
    prompt: '跑一下测试',
    startedAt: at,
  },
}

const stepStarted: CommittedAgentEvent = {
  type: 'step.started',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  step: { kind: 'step', stepId: S1, turnId: T1, ordinal: 1, state: 'running', startedAt: at },
}

const textStarted: CommittedAgentEvent = {
  type: 'item.started',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  stepId: S1,
  itemId: F1,
  frame: { kind: 'text', frameId: F1, role: 'assistant', text: '' },
}

const textDelta = (offset: number, text: string): AgentEvent => ({
  type: 'item.delta',
  durability: 'ephemeral',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  stepId: S1,
  itemId: F1,
  frameId: F1,
  channel: 'text',
  offset,
  text,
})

const textCompleted: CommittedAgentEvent = {
  type: 'item.completed',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  stepId: S1,
  itemId: F1,
  frame: { kind: 'text', frameId: F1, role: 'assistant', text: '最终正文' },
}

const toolStarted: CommittedAgentEvent = {
  type: 'item.started',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  stepId: S1,
  itemId: F2,
  frame: {
    kind: 'tool',
    frameId: F2,
    toolCallId: 'call-1',
    name: 'bash',
    state: 'running',
    inputPending: true,
    input: { command: 'bun' },
  },
}

const toolCompleted: CommittedAgentEvent = {
  type: 'item.completed',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  stepId: S1,
  itemId: F2,
  frame: {
    kind: 'tool',
    frameId: F2,
    toolCallId: 'call-1',
    name: 'bash',
    state: 'done',
    input: { command: 'bun test' },
    output: 'ok',
  },
}

const stepCompleted: CommittedAgentEvent = {
  type: 'step.completed',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  turnId: T1,
  step: {
    kind: 'step',
    stepId: S1,
    turnId: T1,
    ordinal: 1,
    state: 'completed',
    startedAt: at,
    endedAt: at,
  },
}

const runCompleted: CommittedAgentEvent = {
  type: 'run.completed',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  outcome: 'completed',
  endedAt: at,
  durationMs: 1200,
}

const interaction: CommittedAgentEvent = {
  type: 'interaction.requested',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  itemId: 'ix_1',
  interaction: {
    interactionId: 'ix_1',
    interactionKind: 'approval',
    state: 'pending',
    toolCallId: 'call-1',
    request: { toolName: 'bash', title: '允许？', detail: 'Command: bun test', allowSessionScope: true },
  },
}

const compacted: CommittedAgentEvent = {
  type: 'context.compacted',
  durability: 'committed',
  schema: 1,
  at,
  runId: T1,
  item: { kind: 'marker', markerId: 'compaction-1-1', marker: 'compaction', at },
  beforeTurn: 1,
}

const taskStarted: CommittedAgentEvent = {
  type: 'task.started',
  durability: 'committed',
  schema: 1,
  at,
  task: { taskId: 'tk_1', kind: 'shell', state: 'running', detached: true, outputTail: '' },
}

const taskOutput: AgentEvent = {
  type: 'task.output',
  durability: 'ephemeral',
  schema: 1,
  at,
  taskId: 'tk_1',
  offset: 0,
  text: 'building',
}

const todo: CommittedAgentEvent = {
  type: 'todo.updated',
  durability: 'committed',
  schema: 1,
  at,
  todo: { todoId: 'todo-1', items: [{ title: '跑测试', status: 'in_progress' }] },
}

const events: AgentEvent[] = [
  runStarted,
  stepStarted,
  textStarted,
  textDelta(0, '先写'),
  textDelta(2, '一句'),
  textCompleted,
  toolStarted,
  toolCompleted,
  stepCompleted,
  runCompleted,
  interaction,
  compacted,
  taskStarted,
  taskOutput,
  todo,
]

const final = () => reduceAll(EMPTY_THREAD_STATE, events)

describe('ThreadReducer', () => {
  test('一次 fold 与任意切分 fold 相同', () => {
    const full = final()
    for (let cut = 0; cut <= events.length; cut += 1) {
      const split = reduceAll(reduceAll(EMPTY_THREAD_STATE, events.slice(0, cut)), events.slice(cut))
      expect(split.committed).toEqual(full.committed)
      expect(split.overlay.tasks).toEqual(full.overlay.tasks)
    }
  })

  test('同一条 committed 事件重复应用不改变状态', () => {
    let state = final()
    for (const event of events) {
      if (event.durability !== 'committed') continue
      const again = reduce(state, event)
      expect(again).toEqual(state)
    }
    state = reduce(state, runCompleted)
    expect(state).toEqual(final())
  })

  test('ephemeral 只进覆盖层；终态完整载荷替换正文', () => {
    const beforeComplete = reduceAll(EMPTY_THREAD_STATE, events.slice(0, 3))
    const streaming = reduceAll(beforeComplete, [textDelta(0, '先写'), textDelta(2, '一句')])
    expect(textOf(materialize(streaming), F1)).toBe('先写一句')
    expect(textOf(materialize(beforeComplete), F1)).toBe('')

    const completed = reduce(streaming, textCompleted)
    expect(materialize(completed).items).toEqual(materialize(reduce(beforeComplete, textCompleted)).items)
    expect(textOf(materialize(completed), F1)).toBe('最终正文')
  })

  test('工具流式入参与终态完整帧', () => {
    const pending = reduce(reduceAll(EMPTY_THREAD_STATE, [runStarted, stepStarted, toolStarted]), {
      type: 'item.delta',
      durability: 'ephemeral',
      schema: 1,
      at,
      turnId: T1,
      stepId: S1,
      itemId: F2,
      frameId: F2,
      channel: 'tool_input',
      data: { command: 'bun test' },
    })
    expect(toolFrameOf(materialize(pending), F2)?.input).toEqual({ command: 'bun test' })
    const done = reduce(pending, toolCompleted)
    expect(toolFrameOf(materialize(done), F2)).toMatchObject({
      state: 'done',
      output: 'ok',
      input: { command: 'bun test' },
    })
  })

  test('任务输出覆盖不改变已提交层', () => {
    const state = final()
    const withOutput = reduce(state, taskOutput)
    expect(withOutput.committed).toBe(state.committed)
    expect(materialize(withOutput).tasks.get('tk_1')?.outputTail).toBe('building')
  })

  test('快照往返保留状态', () => {
    const state = final()
    const snapshot: ThreadSnapshot = snapshotOf(state, { hasMoreOlder: false })
    expect(stateFromSnapshot(snapshot).committed).toEqual(materialize(state))
    expect(snapshot.interactions).toHaveLength(1)
    expect(snapshot.todos).toHaveLength(1)
    expect(snapshot.items.some((item) => item.kind === 'marker')).toBe(true)
  })

  test('事件 schema 接受提交与瞬态两类', () => {
    for (const event of events) expect(agentEventSchema.safeParse(event).success).toBe(true)
  })
})

function textOf(state: AgentState, id: string): string {
  return state.items
    .flatMap((item) => (item.kind === 'turn' ? item.steps : []))
    .flatMap((step) => step.frames)
    .filter((frame) => frame.frameId === id)
    .map((frame) => (frame.kind === 'text' || frame.kind === 'thinking' ? frame.text : ''))
    .join('')
}

function toolFrameOf(state: AgentState, id: string): Extract<TranscriptFrame, { kind: 'tool' }> | undefined {
  return state.items
    .flatMap((item) => (item.kind === 'turn' ? item.steps : []))
    .flatMap((step) => step.frames)
    .find((frame): frame is Extract<TranscriptFrame, { kind: 'tool' }> => frame.kind === 'tool' && frame.frameId === id)
}
