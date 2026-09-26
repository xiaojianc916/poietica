/*
 * 端到端的判据：桥推出去的 ops，经过真实的投影层之后，三颗按钮真的会被挂出来。
 *
 * 这一条测试跨了两个包（agent-bridge 的产物 + conversation 的投影），因为缺陷正是
 * 跨在这条缝上：桥不产 interaction.upsert，而下游整条链都在等它。分层测各自全绿，
 * 只有把两端接起来才看得见「没有人被问到」。
 *
 * 断言打在链的终点（pendingInteractions 交出的那一件）而不是中间某一格：
 * 中间任何一处对不齐都是同一个症状。
 *
 * 自检跑法：bun test src/__tests__/interaction-reaches-the-dock.test.ts
 */

import { expect, test } from 'bun:test'
import { type AgentTranscriptSnapshot, TranscriptStore } from '@poietica/transcript'
import { interactionOp } from '../projection.ts'

/*
 * 下面两个断言点复制自 packages/conversation，而不是 import 它：
 * agent-bridge 在分层上低于 conversation（tools/architecture/layering.ts），
 * 反向依赖会被闸门拦下。复制的只是**判据本身**（三行），并在此注明正本位置。
 */

/** 正本：packages/conversation/src/transcript/transcript-projector.ts 的 phaseOf。 */
function awaiting(snapshot: AgentTranscriptSnapshot): boolean {
  const approval = snapshot.interactions.some(
    (item) => item.state === 'pending' && item.interactionKind === 'approval',
  )
  return approval
}

/** 正本：packages/conversation/src/timeline/timeline-queries.ts 的 scanPending。 */
function pendingApprovalId(snapshot: AgentTranscriptSnapshot): string | undefined {
  for (let index = snapshot.interactions.length - 1; index >= 0; index -= 1) {
    const item = snapshot.interactions[index]
    if (item?.interactionKind === 'approval' && item.state === 'pending') {
      return item.interactionId
    }
  }
  return undefined
}

function snapshotAfter(
  ops: readonly ReturnType<typeof interactionOp>[number][],
): AgentTranscriptSnapshot {
  const store = new TranscriptStore('session')
  const agent = store.ensureAgent('main')
  const applied = agent.receive(ops)
  expect(applied.gap).toBeUndefined()
  return agent.snapshot()
}

test('a pending approval makes the composer dock mount, with the id the answer command needs', () => {
  const snapshot = snapshotAfter(
    interactionOp({
      interactionId: 'd1',
      kind: 'approval',
      state: 'pending',
      toolCallId: 'bash',
      request: { method: 'select', title: 'Allow tool: bash' },
    }),
  )

  expect(awaiting(snapshot)).toBe(true)
  /*
   * 这一格同时是屏幕的挂载条件与答复的键：人点下去发的是 agent_resolve_permission
   * 的 requestId，它必须与这里那一个**逐字相同**，否则答复落到一个没人等的号上，
   * 上游永远卡着。这正是交互号取上游 d 号（而不是另编一个）的理由。
   */
  expect(pendingApprovalId(snapshot)).toBe('d1')
})

test('answering closes the dock instead of leaving it waiting forever', () => {
  const snapshot = snapshotAfter([
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

  expect(awaiting(snapshot)).toBe(false)
  expect(pendingApprovalId(snapshot)).toBeUndefined()
})

test('a question group reaches the panel with usable questions, not an empty list', () => {
  // 空题组会让面板抛（question-panel 的 `收到一组空题`），所以这一格必须是真题。
  const questions = [
    {
      id: 'q1',
      question: '选哪条路？',
      options: [{ id: 'o0', label: '甲' }],
      multiSelect: false,
      allowOther: true,
    },
  ]

  const snapshot = snapshotAfter(
    interactionOp({
      interactionId: 'd2',
      kind: 'question',
      state: 'pending',
      toolCallId: 'ask',
      request: { questions },
    }),
  )

  const held = snapshot.interactions.find((item) => item.interactionId === 'd2')
  expect(held?.state).toBe('pending')
  expect(held?.interactionKind).toBe('question')

  if (held === undefined) {
    throw new Error('the question group did not reach the snapshot at all')
  }

  // 投影层读的就是这一格（transcript-projector 的 interactionOf）。
  expect((held.request as { questions?: unknown }).questions).toHaveLength(1)
})
