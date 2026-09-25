import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolCallPanels } from '../surface/timeline/tool-call-panels'
import type { ToolCallTimelineItem } from '../timeline/timeline-contract'

/*
 * 抽屉的形制。
 *
 * 一张纸：实色块、没有外框、没有自己的高度上限（上限在面板上），围栏只有正文没有外壳。
 * 这一条钉的就是那次回归：改 CSS 时 __body 多了边框、宽高被放开，而摘围栏外壳的那几条
 * 不见了 —— 于是一次读文件在屏幕上变成一个又宽又高的代码框。
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../surface/timeline/tool-call.css', import.meta.url)),
  'utf8',
)

/** 一条规则的声明块。选择器写多长都行，取到第一个 `}` 为止。 */
function ruleFor(selector: string): string {
  const at = CSS.indexOf(selector)

  expect(at).toBeGreaterThan(-1)

  const open = CSS.indexOf('{', at)
  const close = CSS.indexOf('}', open)

  return CSS.slice(open + 1, close)
}

function readItem(): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id: 'read',
    turn: 0,
    at: 0,
    toolCallId: 'r1',
    title: 'read',
    kind: 'read',
    headline: '阅读 src/app.rs',
    subject: 'src/app.rs',
    shape: 'result',
    status: 'completed',
    requestContent: [],
    content: [{ type: 'command', command: 'fn main() {}', language: 'rust' }],
    locations: [],
    channels: [],
    startedAt: 0,
    endedAt: 1,
  }
}

describe('抽屉的形制', () => {
  it('一面的内容是正文本身，不是一层代码框', () => {
    const markup = renderToStaticMarkup(
      createElement(ToolCallPanels, { isRunning: false, item: readItem() }),
    )

    /* 这张纸：一个 body、一个面板，没有页签（只有产出一面）。 */
    expect(markup).toContain('timeline-tool__body')
    expect(markup).toContain('timeline-tool__panel')
    expect(markup).not.toContain('role="tablist"')
    expect(markup).toContain('fn main()')
  })

  /*
   * 围栏在抽屉里不封顶，而那件事**必须**在传参处做。
   *
   * Streamdown 把 codeBlockMaxHeight 写成内联 maxHeight 加 overflow-y-auto，内联样式
   * 压不过样式表 —— 只在 CSS 里摘上限，围栏仍然是面板里第二个滚动容器，屏幕上多出
   * 一条贴着自己底边的滚动条（就是那条。0 是 Streamdown 自己的「禁用」值）。
   */
  it('围栏不带自己的高度上限：上限只归面板', () => {
    const markup = renderToStaticMarkup(
      createElement(ToolCallPanels, { isRunning: false, item: readItem() }),
    )

    const body = /data-streamdown="code-block-body"[^>]*/.exec(markup)?.[0] ?? ''

    expect(body).not.toBe('')
    expect(body).not.toContain('max-height')
    expect(body).not.toContain('overflow-y-auto')
  })

  it('那张纸是一个封顶的实色块，不是一张带边框的卡', () => {
    const body = ruleFor('.timeline-tool__body {')

    /* 宽度上限：右边缘与那一行齐平。 */
    expect(body).toContain('--cp-timeline-tool-max')
    expect(body).toContain('border-radius: var(--cp-radius-item)')
    expect(body).toContain('background: var(--cp-timeline-drawer-surface)')
    /* 外框与投影归 [data-surface]，戴它的是需要人回答的东西。 */
    expect(body).not.toMatch(/\bborder:/)
    expect(body).not.toMatch(/box-shadow/)
  })

  it('面板是唯一的滚动容器，上限挂在自己身上', () => {
    const panel = ruleFor('.timeline-tool__panel {')

    expect(panel).toContain('max-block-size: var(--cp-timeline-output-max)')
    expect(panel).toContain('overflow: auto')
    /* 60vh 是那次回归引入的：上限必须与长产出虚拟化用同一个令牌。 */
    expect(panel).not.toContain('60vh')
  })

  it('抽屉里的围栏只有正文，没有外壳', () => {
    /* 语言胶囊与复制按钮不画。 */
    expect(ruleFor('[data-streamdown="code-block-header"],')).toContain('display: none')
    /* 围栏不再是第二个滚动容器，也不再自带边框与底色。 */
    const fence = ruleFor('[data-streamdown="code-block"] {')

    expect(fence).toContain('border: 0')
    expect(fence).toContain('background: transparent')
    const body = ruleFor('[data-streamdown="code-block-body"] {')

    expect(body).toContain('max-block-size: none')
    expect(body).toContain('overflow: visible')
    expect(body).toContain('border: 0')
    /* 代码不折行：列对齐是等宽排版全部的价值。 */
    expect(ruleFor('[data-streamdown="code-block-body"] pre {')).toContain('white-space: pre')
  })
})
