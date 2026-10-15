import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../agent/transcript'
import { type ProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * R-19-1：用户气泡上的图。
 *
 * - 插话 / followUp 那一句的图挂在**人话帧**上（不在轮头），投影必须按帧上的号去找；
 * - 附件索引不能只在「轮头带号」时才建，否则只有插话带图的那一页永远解析不到；
 * - 附件条目后到 / 换了像素时，按轮缓存的投影必须失效，不能一直画旧的（或空的）。
 */

const AT = '2026-10-10T00:00:00.000Z'
const PNG = 'data:image/png;base64,QUJD'
const memo = (): ProjectionMemo => ({ sealed: [], outline: [] })

function attachmentOp(attachmentId: string, url: string): TranscriptOperation {
  return {
    op: 'attachment.upsert',
    attachment: { attachmentId, mediaType: 'image/png', source: { kind: 'url', url } },
  } as unknown as TranscriptOperation
}

/** 一轮在跑的对话：开轮那一句 + 一句插话（插话帧可带图） */
function steeredTurn(frameIds: readonly string[] | undefined, headIds?: readonly string[]): TranscriptOperation[] {
  const turnId = 't1'
  const stepId = 't1:s0'
  return [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal: 1,
        state: 'running',
        origin: { kind: 'user' },
        prompt: '开头一句',
        startedAt: AT,
        ...(headIds === undefined ? {} : { attachmentIds: headIds }),
      },
    },
    { op: 'step.upsert', turnId, step: { kind: 'step', stepId, turnId, ordinal: 0, state: 'running', startedAt: AT } },
    {
      op: 'frame.upsert',
      turnId,
      stepId,
      frame: {
        kind: 'text',
        frameId: `${stepId}:f0`,
        role: 'user',
        text: '插话带图',
        origin: { kind: 'user' },
        ...(frameIds === undefined ? {} : { attachmentIds: frameIds }),
      },
    },
  ] as unknown as TranscriptOperation[]
}

function pageOf(state: ReturnType<typeof emptyTimeline>): TranscriptPage {
  return {
    ...pageFromState(state),
    agentId: 'main',
    agents: [],
    pendingInteractions: [],
    seq: 1,
  } as unknown as TranscriptPage
}

interface UserMessage {
  readonly type: 'user_message'
  readonly text: string
  readonly images?: readonly { readonly url?: string; readonly pending?: boolean }[]
}

/** 投影结果里所有用户气泡（不关心它落在 sealed 还是 active） */
function userMessages(value: unknown, out: UserMessage[] = [], seen = new Set<unknown>()): UserMessage[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return out
  seen.add(value)
  if ((value as { type?: unknown }).type === 'user_message') out.push(value as UserMessage)
  for (const child of Object.values(value as Record<string, unknown>)) userMessages(child, out, seen)
  return out
}

const bubble = (state: ReturnType<typeof emptyTimeline>, text: string, m = memo()) =>
  userMessages(projectTranscript(pageOf(state), m)).find((message) => message.text === text)

test('A1 插话帧上的图：气泡画得出来（轮头不带号也要建索引）', () => {
  const state = applyOps(emptyTimeline(), [attachmentOp('img-1', PNG), ...steeredTurn(['img-1'])])

  expect(bubble(state, '插话带图')?.images).toEqual([{ url: PNG }])
  expect(bubble(state, '开头一句')?.images).toBeUndefined()
})

test('A2 轮头带图：开轮那一句的气泡照常有图', () => {
  const state = applyOps(emptyTimeline(), [attachmentOp('img-h', PNG), ...steeredTurn(undefined, ['img-h'])])

  expect(bubble(state, '开头一句')?.images).toEqual([{ url: PNG }])
})

test('A3 条目后到：同一轮的投影缓存失效，补上图', () => {
  const m = memo()
  const before = applyOps(emptyTimeline(), steeredTurn(['img-2']))
  expect(bubble(before, '插话带图', m)?.images).toBeUndefined()

  const after = applyOps(before, [attachmentOp('img-2', PNG)])
  expect(bubble(after, '插话带图', m)?.images).toEqual([{ url: PNG }])
})

test('A4 条目换了像素：不沿用旧的投影', () => {
  const m = memo()
  const first = applyOps(emptyTimeline(), [attachmentOp('img-3', PNG), ...steeredTurn(undefined, ['img-3'])])
  expect(bubble(first, '开头一句', m)?.images).toEqual([{ url: PNG }])

  const other = 'data:image/png;base64,REVG'
  const second = applyOps(first, [attachmentOp('img-3', other)])
  expect(bubble(second, '开头一句', m)?.images).toEqual([{ url: other }])
})
