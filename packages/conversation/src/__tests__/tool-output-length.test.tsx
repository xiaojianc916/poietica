import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { fencedBodyOf, toToolCallFacets } from '../surface/semantics/tool-call-facets'
import { ToolCallPanels } from '../surface/timeline/tool-call-panels'
import { VIRTUAL_ABOVE_LINES } from '../surface/timeline/tool-output-lines'
import type { ToolCallTimelineItem } from '../timeline/timeline-contract'

/*
 * 抽屉里那一面的长度。
 *
 * 两件事各有一条判据：文本一个字符都不许少（这里此前按 64 KiB 截断），而长到几百行
 * 的那一段改由虚拟化画（DOM 里只留视口那几行）。
 */

function outputItem(text: string): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id: 'tool-output',
    turn: 0,
    at: 0,
    toolCallId: 'output-1',
    title: '搜索',
    kind: 'search',
    subject: '**/*.png',
    status: 'completed',
    requestContent: [],
    content: [{ type: 'content', content: { type: 'text', text } }],
    locations: [],
    channels: [],
    startedAt: 0,
    endedAt: 1,
  }
}

function panelOf(text: string): string {
  return renderToStaticMarkup(<ToolCallPanels isRunning={false} item={outputItem(text)} />)
}

function linesOf(count: number): string {
  return Array.from({ length: count }, (_unused, index) => `line-${String(index)}`).join('\n')
}

/** 一块围栏的行盒高度：--ui-prose-size-aux（13px）× --ui-line-height-normal（1.5）。 */
const LINE_PX = 19.5

describe('抽屉里那段输出的长度', () => {
  it('短产出走 markdown，一个字不少', () => {
    const markup = panelOf(linesOf(4))

    expect(markup).toContain('line-0')
    expect(markup).toContain('line-3')
    expect(markup).not.toContain('timeline-tool__output')
    expect(markup).not.toContain('内容过长')
  })

  it('超过阈值改由虚拟化画，高度按总行数算', () => {
    const count = VIRTUAL_ABOVE_LINES + 137
    const markup = panelOf(linesOf(count))

    expect(markup).toContain('timeline-tool__output')
    expect(markup).toContain(String(count * LINE_PX))
    /* 围栏记号不该漏到屏幕上：虚拟化那一面画的是围栏里的行。 */
    expect(markup).not.toContain('```')
    expect(markup).not.toContain('内容过长')
  })

  it('超出视口的行不进 DOM', () => {
    const count = VIRTUAL_ABOVE_LINES * 4
    const markup = panelOf(linesOf(count))

    expect(markup).not.toContain('line-0</')
    expect(markup).not.toContain(`line-${String(count - 1)}`)
  })
})

describe('长产出不再被截断', () => {
  it('超过 64 KiB 的产出一个字符不少', () => {
    const count = 8000
    const text = linesOf(count)

    expect(text.length).toBeGreaterThan(64 * 1024)

    const facets = toToolCallFacets({
      content: [{ type: 'content', content: { type: 'text', text } }],
    })

    expect(facets.response).toContain(`line-${String(count - 1)}`)
    expect(facets.response).not.toContain('内容过长')
  })
})

describe('围栏的逆运算', () => {
  it('取回块里的行', () => {
    expect(fencedBodyOf('```text\na\nb\n```')).toEqual(['a', 'b'])
  })

  it('围栏比正文里的反引号还长一格，逆运算跟着走', () => {
    expect(fencedBodyOf('````text\n```\n````')).toEqual(['```'])
  })

  it('不是一整块围栏就交回 null', () => {
    for (const markdown of ['', '一段正文', '```text\n没闭合', '- [ ] 待办\n- [x] 好了']) {
      expect(fencedBodyOf(markdown)).toBeNull()
    }
  })
})
