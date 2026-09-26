/*
 * 投影出来的「在等人答」这一条，落进 reducer 之后屏幕真的能看见。
 *
 * 这一条链子是：interactionOp → transcript store 的 interactions → projectTranscript
 * 的 phaseOf 决出 awaiting_permission → pendingInteractions 交出那一件。
 * 断言的终点就是三颗按钮的挂载条件（assistant-surface 的 approval memo）——
 * 只测 op 形状会漏掉整条链上任何一处对不齐。
 *
 * 自检跑法：bun test src/__tests__/interaction.test.ts
 */

import { expect, test } from 'bun:test'
import { applyOperation, EMPTY_AGENT_STATE, transcriptOperationSchema } from '@poietica/transcript'
import { interactionOp } from '../projection.ts'

/** 一串 op 落进 reducer 之后的状态；gap 是缺陷，不允许出现。 */
function settle(ops: ReturnType<typeof interactionOp>) {
  let state = EMPTY_AGENT_STATE

  for (const op of ops) {
    const result = applyOperation(state, op)
    expect(result.gap).toBeUndefined()
    state = result.state
  }

  return state
}

test('a pending approval reaches the store as a pending interaction', () => {
  const ops = interactionOp({
    interactionId: 'd1',
    kind: 'approval',
    state: 'pending',
    toolCallId: 'bash',
    request: { method: 'select', title: 'Allow tool: bash' },
  })

  const state = settle(ops)

  expect(state.interactions.get('d1')).toMatchObject({
    interactionKind: 'approval',
    state: 'pending',
    toolCallId: 'bash',
  })
  // 三颗按钮的挂载条件直接读这个集合。
  expect([...state.pendingInteractions]).toEqual(['d1'])
})

test('the op is the shape the wire schema pins', () => {
  // 校验打在正本上：op 的字段名由 packages/transcript 的 schema 钉死，抄一份在桥里就是第二个事实。
  for (const op of interactionOp({
    interactionId: 'd1',
    kind: 'approval',
    state: 'pending',
    toolCallId: 'bash',
  })) {
    expect(transcriptOperationSchema.safeParse(op).success).toBe(true)
  }
})

test('settling the same id flips the row and clears it from what is waiting', () => {
  const state = settle([
    ...interactionOp({
      interactionId: 'd1',
      kind: 'approval',
      state: 'pending',
      toolCallId: 'bash',
    }),
    ...interactionOp({
      interactionId: 'd1',
      kind: 'approval',
      state: 'approved',
      toolCallId: 'bash',
      response: { decision: 'approved' },
    }),
  ])

  expect(state.interactions.get('d1')?.state).toBe('approved')
  // 答完就不再等人：输入框那条带子因此收起来。
  expect([...state.pendingInteractions]).toEqual([])
})

test('a question group carries the questions the panel reads, and is not additive', () => {
  const questions = [
    {
      id: 'q1',
      question: '选哪条路？',
      options: [{ id: 'o0', label: '甲' }],
      multiSelect: false,
      allowOther: true,
    },
  ]

  const state = settle(
    interactionOp({
      interactionId: 'd2',
      kind: 'question',
      state: 'pending',
      toolCallId: 'ask',
      request: { questions },
    }),
  )

  // 投影层从 interaction.request 的 `questions` 取题（transcript-projector 的 interactionOf）。
  expect(state.interactions.get('d2')?.request).toEqual({ questions })
  expect([...state.pendingInteractions]).toEqual(['d2'])
})

test('two outstanding interactions are both counted, so the dock can report 1/N', () => {
  const state = settle([
    ...interactionOp({
      interactionId: 'd1',
      kind: 'approval',
      state: 'pending',
      toolCallId: 'bash',
    }),
    ...interactionOp({
      interactionId: 'd2',
      kind: 'approval',
      state: 'pending',
      toolCallId: 'write',
    }),
  ])

  expect([...state.pendingInteractions]).toEqual(['d1', 'd2'])
})
