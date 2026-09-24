/*
 * 桥这一侧屏幕经过的镜像：推出去什么，这里就落什么；读的时候从它答。
 *
 * 自检跑法：bun test src/__tests__/transcript-mirror.test.ts
 */

import { expect, test } from 'bun:test'
import { transcriptOpsPayloadSchema, transcriptResponseSchema } from '@poietica/transcript'
import { TranscriptMirror } from '../transcript-mirror.ts'

const TURN = [
  {
    op: 'turn.upsert' as const,
    turn: {
      kind: 'turn' as const,
      turnId: 't1',
      ordinal: 1,
      state: 'running' as const,
      origin: { kind: 'user' as const },
      prompt: 'hi',
    },
  },
]

/*
 * 判据照抄读者：native-bridge 的 decodeTranscriptEvent 要求顶层同时有 `type` 与
 * `payload`，再用 transcriptOpsPayloadSchema 校验 payload。断言直接打在同一个
 * 两步上 —— 只测我们自己那半边的形状，是上一版漏掉 `seq` 还能全绿的原因。
 */
function decode(pushed: unknown): { seq?: number | undefined; ops: readonly unknown[] } {
  const envelope = pushed as { type?: unknown; payload?: unknown }
  expect(envelope.type).toBe('transcript.ops')

  return transcriptOpsPayloadSchema.parse(envelope.payload)
}

test('a pushed batch is the envelope the client decodes, and it carries a watermark', () => {
  const mirror = new TranscriptMirror('session')

  expect(decode(mirror.accept(TURN)).seq).toBe(1)
  expect(decode(mirror.accept(TURN)).seq).toBe(2)
})

test('the baseline page is a real page the client can seed from', () => {
  const mirror = new TranscriptMirror('session')
  mirror.accept(TURN)

  const page = transcriptResponseSchema.parse(mirror.page('main'))

  expect(page.items).toHaveLength(1)
  expect(page.seq).toBe(1)
  // 手上就是这条会话的全部 ops，没有更早的一页可翻。
  expect(page.has_more).toBe(false)
})

test('catch-up returns only what is missing, and stays replayable from zero', () => {
  const mirror = new TranscriptMirror('session')
  mirror.accept(TURN)
  mirror.accept(TURN)

  const behind = mirror.catchUp('main', 1) as { batches: unknown[]; latest_seq: number }
  expect(behind.batches).toHaveLength(1)
  expect(behind.latest_seq).toBe(2)

  const cold = mirror.catchUp('main', 0) as { batches: unknown[]; latest_seq: number }
  expect(cold.batches).toHaveLength(2)
  expect(cold.latest_seq).toBe(2)

  const current = mirror.catchUp('main', 2) as { batches: unknown[] }
  expect(current.batches).toHaveLength(0)
})

test('an untouched session still answers with a valid empty page', () => {
  const page = transcriptResponseSchema.parse(new TranscriptMirror('session').page('main'))

  expect(page.items).toEqual([])
  expect(page.seq).toBe(0)
})
