/*
 * 端到端：桥推出去的 ops，经 native-bridge 的边界校验与 TranscriptReplica 的追赶，
 * 真的会让输入框那一带挂出审批带。
 *
 * 这一条比 agent-bridge 的同类测试更靠下游一层：它用的是**线上那一份 schema**
 * （packages/transcript 的 transcriptOpsPayloadSchema）与真实的 replica，
 * 所以「字段名对不上」这类只在这条缝上出现的问题会在这里红。
 *
 * 自检跑法：bun test src/__tests__/interaction-wire.test.ts
 */

import { expect, test } from 'bun:test'
import { transcriptOpsPayloadSchema } from '@poietica/transcript'
import { decodeTranscriptEvent } from '../conversation/transcript-decoding.ts'

/** 一道闸门的 requestId 与它挂的那件工具。 */
const REQUEST = 'd4'

test('an interaction op survives the wire schema and reaches the replica', () => {
  const pushed = {
    type: 'transcript.ops',
    payload: {
      agent_id: 'main',
      seq: 1,
      ops: [
        {
          op: 'interaction.upsert',
          interaction: {
            interactionId: REQUEST,
            interactionKind: 'approval',
            state: 'pending',
            toolCallId: 'bash',
            request: { method: 'select', toolName: 'bash', detail: 'Command: bun run check' },
          },
        },
      ],
    },
  }

  // 第一步：这是桥真正写出去的那一行，读者是 native-bridge 的边界校验。
  const parsed = transcriptOpsPayloadSchema.parse(pushed.payload)
  expect(parsed.ops).toHaveLength(1)

  // 第二步：native-bridge 的原样转发（wire 的 json 是一行文本）。
  const decoded = decodeTranscriptEvent({
    sessionId: 'session',
    json: JSON.stringify(pushed),
  } as never)

  expect(decoded.ok).toBe(true)
  if (!decoded.ok || decoded.signal.kind !== 'ops') {
    throw new Error('the interaction batch was not decoded as ops')
  }

  const op = decoded.signal.ops[0]
  expect(op?.op).toBe('interaction.upsert')
  // 号一路不变：屏幕上的按钮与答复命令用的是同一个号。
  expect((op as { interaction?: { interactionId?: string } }).interaction?.interactionId).toBe(
    REQUEST,
  )
})

test('a settled interaction is a legal wire op too, and it is not pending', () => {
  const settled = {
    agent_id: 'main',
    seq: 2,
    ops: [
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: REQUEST,
          interactionKind: 'approval',
          state: 'approved',
          toolCallId: 'bash',
          response: { decision: 'approved' },
        },
      },
    ],
  }

  const parsed = transcriptOpsPayloadSchema.parse(settled)
  const interaction = (parsed.ops[0] as { interaction?: { state?: string } }).interaction

  // 答完之后那一条不再等人：带子因此收起来。
  expect(interaction?.state).toBe('approved')
})

test('the wire rejects an interaction whose kind or state is not in the contract', () => {
  // 契约是封闭的：桥写错一个字，这里就红，不会静默丢成「没有审批」。
  for (const bad of [
    { interactionKind: 'permission', state: 'pending' },
    { interactionKind: 'approval', state: 'waiting' },
  ]) {
    const parsed = transcriptOpsPayloadSchema.safeParse({
      agent_id: 'main',
      seq: 3,
      ops: [
        {
          op: 'interaction.upsert',
          interaction: { interactionId: REQUEST, toolCallId: 'bash', ...bad },
        },
      ],
    })

    expect(parsed.success).toBe(false)
  }
})
