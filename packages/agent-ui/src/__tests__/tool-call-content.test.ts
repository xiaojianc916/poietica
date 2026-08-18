import { describe, expect, it } from 'vitest'
import { toToolContentParts } from '../semantics/tool-call-content'

/**
 * 工具卡片画什么。
 *
 * 这里测的只是这一层自己的映射：一个内容块进去，一张卡片画得出的片段出来。
 * 「线上真的送来什么」由投影层的用例守着，不在这里再断言一遍 —— 这一层看不见帧。
 */

describe('what a tool call has to show', () => {
  it('drops the empty bubble a tool call opens with', () => {
    const parts = toToolContentParts([{ type: 'content', content: { type: 'text', text: '' } }])

    expect(parts).toEqual([])
  })

  it('keeps text a card can draw', () => {
    const parts = toToolContentParts([
      { type: 'content', content: { type: 'text', text: 'Poietica' } },
    ])

    expect(parts).toEqual([{ type: 'text', text: 'Poietica' }])
  })

  it('keeps a diff whole, and says when there was nothing before it', () => {
    const parts = toToolContentParts([
      { type: 'diff', path: 'notes.md', newText: 'after' },
      { type: 'terminal', terminalId: 'term_1' },
    ])

    expect(parts).toEqual([
      { type: 'diff', path: 'notes.md', oldText: null, newText: 'after' },
      { type: 'terminal', terminalId: 'term_1' },
    ])
  })

  it('names a block it cannot draw instead of inventing one', () => {
    const parts = toToolContentParts([
      { type: 'content', content: { type: 'image', data: 'x', mimeType: 'image/png' } },
    ])

    expect(parts).toEqual([{ type: 'opaque', label: '一张图片' }])
  })
})
