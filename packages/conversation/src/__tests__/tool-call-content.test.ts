import { describe, expect, it } from 'bun:test'
import { toToolContentParts } from '../surface/semantics/tool-call-content'

// 只测这一层的映射：内容块 → 可画片段。线上帧由投影层用例守。

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

  it('keeps a linked resource reachable instead of naming it away', () => {
    const parts = toToolContentParts([
      { type: 'resource_link', uri: 'https://x/y.png', name: 'shot' },
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inline' } },
      { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AA==' } },
    ])

    expect(parts).toEqual([
      { type: 'link', uri: 'https://x/y.png', name: 'shot' },
      { type: 'text', text: 'inline' },
      { type: 'link', uri: 'file:///b.bin', name: null },
    ])
  })

  it('把图按正本画出来：base64 与 mimeType 就是它的形状', () => {
    const parts = toToolContentParts([
      { type: 'content', content: { type: 'image', data: 'QUJD', mimeType: 'image/webp' } },
    ])

    expect(parts).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/webp' }])
  })

  it('画不出来的块留个名字，不发明一种画法', () => {
    const parts = toToolContentParts([
      { type: 'content', content: { type: 'audio', data: 'AA==', mimeType: 'audio/mpeg' } },
    ])

    expect(parts).toEqual([{ type: 'opaque', label: '一段音频' }])
  })

  it('keeps what we sent drawable on its own terms', () => {
    const parts = toToolContentParts([
      { type: 'command', command: 'bun run check', language: 'bash' },
      { type: 'prose', text: '## 步骤' },
      { type: 'todo', items: [{ title: '建索引', status: 'done' }] },
      { type: 'prose', text: '' },
      { type: 'todo', items: [] },
    ])

    expect(parts).toEqual([
      { type: 'command', command: 'bun run check', language: 'bash' },
      { type: 'prose', text: '## 步骤' },
      { type: 'todo', items: [{ title: '建索引', status: 'done' }] },
    ])
  })
})
