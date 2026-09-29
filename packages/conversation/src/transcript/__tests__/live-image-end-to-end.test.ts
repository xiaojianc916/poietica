/*
 * 端到端：随消息发出的图，最后真的画在对话里。
 *
 * 这条测试钉的是那次故障的后半截 —— 当时的缺口不只是「模型没收到」，还有
 * 「屏幕上什么都没有」。它跨两段：
 *   桥发出的那两批 op（attachment.upsert + 引用它的 turn.upsert）
 *     → @poietica/transcript 的 AgentTranscript 落进快照
 *     → 本包的 projectTranscript 投影成时间线上的图片。
 *
 * 形状按 @poietica/transcript 的契约手写，不 import 桥：agent-bridge 在 foundation
 * 环、本包在 feature 环（tools/architecture/layering.ts），反着引既破分层又拖进整个 SDK。
 *
 * 中间任何一段断掉（号写错、投影器认不出 source），这里就是红的。
 * 跑法：cd packages/conversation && bun test src/transcript/__tests__/live-image-end-to-end.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { AgentTranscript, type AgentTranscriptSnapshot } from '@poietica/transcript'
import { allItems } from '../../timeline/timeline-contract'
import { projectTranscript } from '../transcript-projector'

/** 一张 1×1 的 PNG。 */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const DATA_URL = `data:image/png;base64,${PIXEL}`

/*
 * 桥现场发图时推的那两批 op，次序与 bridge.ts 的 sendPrompt 逐字相同：
 * 附件 upsert 先落地，引用它的那一轮再开。
 *
 * `text` 为空就是「只有图、没有字」那一条 —— 截图是整条消息，不是谁的话。
 */
function sent(text: string): AgentTranscriptSnapshot {
  const transcript = new AgentTranscript('main')
  const attachmentId = 'prompt:p1:0'

  transcript.receive([
    {
      op: 'attachment.upsert',
      attachment: {
        attachmentId,
        mediaType: 'image/png',
        source: { kind: 'url', url: DATA_URL },
        name: 'shot.png',
      },
    },
  ])

  transcript.receive([
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'running',
        origin: { kind: 'user' },
        prompt: text,
        startedAt: '2026-09-29T00:00:00.000Z',
        triggerPromptId: 'p1',
        attachmentIds: [attachmentId],
      },
    },
  ])

  return transcript.snapshot()
}

function userMessage(snapshot: AgentTranscriptSnapshot) {
  const item = allItems(projectTranscript(snapshot)).find((entry) => entry.type === 'user_message')

  if (item?.type !== 'user_message') {
    throw new Error('这一轮应当投影成一条用户消息')
  }

  return item
}

describe('现场发出的图片走完整条链路后画得出来', () => {
  test('附件先落地、turn 再引用它 —— 投影出来是一张带像素的用户消息', () => {
    const message = userMessage(sent('这是什么'))

    /* 正文是原话；图挂在 images 上，由 user-message.tsx 交给 MessageAttachments 画。 */
    expect(message.text).toBe('这是什么')
    expect(message.images).toEqual([{ url: DATA_URL }])
  })

  test('只有图、没有字的消息也成一行 —— 截图是整条消息', () => {
    const message = userMessage(sent(''))

    /* 界面按「有附件」判行（renderable.ts），不替人补一句「[图片]」。 */
    expect(message.text).toBe('')
    expect(message.images).toEqual([{ url: DATA_URL }])
  })

  test('字节还没代取回来的图只画占位，不编一个地址出来', () => {
    const transcript = new AgentTranscript('main')

    transcript.receive([
      {
        op: 'attachment.upsert',
        attachment: {
          attachmentId: 'prompt:p2:0',
          mediaType: 'image/png',
          source: { kind: 'file', fileId: 'media-1' },
          name: 'shot.png',
        },
      },
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'running',
          origin: { kind: 'user' },
          prompt: '',
          startedAt: '2026-09-29T00:00:00.000Z',
          attachmentIds: ['prompt:p2:0'],
        },
      },
    ])

    expect(userMessage(transcript.snapshot()).images).toEqual([{ pending: true }])
  })
})
