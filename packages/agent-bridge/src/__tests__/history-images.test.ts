/*
 * 历史里的图片。
 *
 * 缘起是一个真实的缺口：omp 读会话文件时已经把 blob 引用换回 base64 内联进消息正文
 * （`session-loader.ts` 的 `resolveBlobRefsInEntries` → `resolveImageData`），而桥只取
 * 文本块、把图片块整块丢掉 —— 于是重开一条带图的会话，图全都不见了。
 *
 * 当时那句注释写的是「图片块在会话媒体库里」，而 **omp 根本没有会话媒体库**（查过：
 * 整个 pi-coding-agent 树里没有 sessionMedia / mediaLibrary / readMedia）。像素就在
 * 手上，缺的只是把它交出去。
 *
 * 自检跑法：bun test src/__tests__/history-images.test.ts
 */

import { expect, test } from 'bun:test'
import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'
import { attachmentOp } from '../projection.ts'

/** 一张 1×1 的 PNG，够证明「像素过得了这条线」而不必带大文件。 */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('an image block becomes an attachment the frontend can draw', () => {
  let state = EMPTY_AGENT_STATE

  for (const op of attachmentOp({
    attachmentId: 'image-0',
    mediaType: 'image/png',
    dataUrl: `data:image/png;base64,${PIXEL}`,
  })) {
    state = applyOperation(state, op).state
  }

  const held = state.attachments.get('image-0')

  expect(held).toBeDefined()
  expect(held?.mediaType).toBe('image/png')

  /*
   * 源必须是 `url` 且带得出像素：界面按这一格直接画（transcript-projector 的 imageUrlOf
   * 对 `url` 源原样返回），所以 data URL 一到手就能上屏，不必再开一条取字节的通道。
   */
  expect(held?.source?.kind).toBe('url')

  if (held?.source?.kind === 'url') {
    expect(held.source.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(held.source.url).toContain(PIXEL)
  }
})

test('a bare base64 payload is turned into a data URL, not passed through raw', () => {
  /* 上游给的是裸 base64；`url` 源要的是 data URL，原样给出去画不出来。 */
  const [op] = attachmentOp({
    attachmentId: 'image-1',
    mediaType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${PIXEL}`,
  })

  expect(op?.op).toBe('attachment.upsert')

  if (op?.op === 'attachment.upsert') {
    expect(op.attachment.source).toEqual({
      kind: 'url',
      url: `data:image/jpeg;base64,${PIXEL}`,
    })
  }
})

test('an attachment carries the media type the block declared', () => {
  const [op] = attachmentOp({
    attachmentId: 'image-2',
    mediaType: 'image/webp',
    dataUrl: 'data:image/webp;base64,AAAA',
    name: 'screenshot.webp',
  })

  if (op?.op === 'attachment.upsert') {
    expect(op.attachment.mediaType).toBe('image/webp')
    expect(op.attachment.name).toBe('screenshot.webp')
  }
})
