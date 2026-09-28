import { describe, expect, it } from 'bun:test'
import { type ComposerAsset, isInlineAttachment } from '../composer/attachment'
import { samePromptChip } from '../surface/primitives/prompt-chip'

/* 这条判据决定一份字节由正文里的记号还是附件条上的缩略图代表它发出去。 */
const asset = (kind: ComposerAsset['kind'], context?: ComposerAsset['context']): ComposerAsset => ({
  sessionToken: 'session',
  assetToken: `${kind}-token`,
  url: kind === 'image' ? 'poietica-asset://session/image-token' : '',
  filename: kind === 'image' ? 'shot.png' : 'notes.txt',
  mediaType: kind === 'image' ? 'image/png' : 'text/plain',
  size: 12,
  kind,
  ...(context === undefined ? {} : { context }),
})

describe('composer attachment routing', () => {
  it('通用文件与元素上下文走正文里的记号', () => {
    expect(isInlineAttachment(asset('file'))).toBe(true)
    expect(isInlineAttachment(asset('file', { kind: 'browser-element', label: 'button' }))).toBe(
      true,
    )
  })

  it('图片留在附件条那一排，不进正文', () => {
    expect(isInlineAttachment(asset('image'))).toBe(false)
  })

  it('同一份字节只认一枚记号：元素与通用文件都以资产 token 为身份', () => {
    const file = { kind: 'file', assetToken: 'token', name: 'notes.txt' } as const
    const element = { kind: 'element', assetToken: 'token', label: 'button' } as const

    expect(samePromptChip(file, { ...file })).toBe(true)
    expect(samePromptChip(file, { ...file, assetToken: 'other' })).toBe(false)
    expect(samePromptChip(element, { ...element })).toBe(true)
    /* 种类不同不互相顶掉：技能名与资产 token 各是各的身份。 */
    expect(samePromptChip(file, { kind: 'skill', name: 'notes.txt' })).toBe(false)
  })
})
