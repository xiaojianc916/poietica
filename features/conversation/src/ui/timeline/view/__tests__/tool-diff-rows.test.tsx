import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { ToolCallPanels } from '../tools/tool-call-panels'

/* 抽屉里那处改动画的必须是全仓唯一一份行带（design-system 的 DiffBody）：行号槽、增删底色、
 * 词级强调、虚拟化都在那一份里。这条钉的是回归 —— 抽屉曾退化成自己排的一串裸行
 * （timeline-tool__diff-*），没有行号槽样式、没有增删底色，分不出哪行是删哪行是增。 */

const BEFORE = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join('\n')
const AFTER = BEFORE.replace('\nline 15\n', '\nline fifteen\n')

function editItem(oldText: string, newText: string): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id: 'edit',
    turn: 0,
    at: 0,
    toolCallId: 'e1',
    title: 'edit',
    invokedTool: 'edit',
    scheme: '',
    kind: 'edit',
    headline: '编辑 bridge.ts',
    subject: 'bridge.ts',
    shape: 'diff',
    status: 'completed',
    requestContent: [],
    content: [{ type: 'diff', path: 'src/bridge.ts', oldText, newText }],
    locations: [],
    channels: [],
    startedAt: 0,
    endedAt: 1,
  }
}

function markupOf(newText: string): string {
  return renderToStaticMarkup(<ToolCallPanels isRunning={false} item={editItem(BEFORE, newText)} />)
}

describe('抽屉里那处改动的画法', () => {
  it('行带用的是全仓那一份，不是抽屉自己的一套', () => {
    const markup = markupOf(AFTER)

    expect(markup).toContain('diff-body')
    expect(markup).toContain('diff-line')
    expect(markup).not.toContain('timeline-tool__diff-row')
  })

  it('屏幕上一个滚动出口：横条不归行带自己', () => {
    const markup = markupOf(AFTER)

    /* 行带自己横滚会出现第二条横条，抽屉里关掉；自绘的伪滚动条也已删。 */
    expect(markup).not.toContain('overflow-x-auto')
    expect(markup).not.toContain('timeline-tool__diff-scrollbar')
    expect(markup).not.toContain('type="range"')
    expect(markup).toContain('data-scrollable')
  })

  it('抽屉里不画折叠带，也没有占位记号', () => {
    const markup = markupOf(AFTER)

    /* 只取三行上下文，跳过的行从没进过模型，那句「N unmodified lines」展不开也说不明。 */
    expect(markup).not.toContain('unmodified lines')
    expect(markup).not.toContain('diff-gap')
    /* 折叠带那类没有行号的行曾印一个「⋯」占位，是第二种说法。 */
    expect(markup).not.toContain('⋯')
  })
})
