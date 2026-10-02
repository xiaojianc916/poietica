import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computeFile } from '@poietica/review'
import { paint } from '@poietica/review/surface'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolCallPanels } from '../surface/timeline/tool-call-panels'
import type { ToolCallTimelineItem } from '../timeline/timeline-contract'

/*
 * 抽屉里的那处改动。
 *
 * 它画的是审查面板那份行带（@poietica/review/surface 的 DiffBody），所以这里钉的是
 * 「不再自己排一套」：抽屉里没有第二条横条、没有自绘的滚动条、没有行带自己的横滚出口。
 * 这一条钉的就是那次回归 —— diff 曾是抽屉里第二套行渲染，带一对 range 伪滚动条。
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../surface/timeline/tool-call.css', import.meta.url)),
  'utf8',
)

/* 改动落在中段：hunk 前面那些未改动行折成一条折叠带（没有行号）。 */
const BEFORE = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join('\n')
const AFTER = BEFORE.replace('\nline 15\n', '\nline fifteen\n')

/* 一段真代码：一行里切得出多种语法色，才验得动着色器。 */
const CODE = [
  'export function createBridge(): Bridge {',
  '  const resolved = getAgentDir()',
  '  return { host: "local", resolved }',
  '}',
].join('\n')
const CODE_AFTER = CODE.replace(
  '  const resolved = getAgentDir()',
  '  const resolved = getAgentDir()\n  ensureThemeSync()',
)

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

    /* 行带本身来自 @poietica/review/surface：抽屉不再有自己的行类名。 */
    expect(markup).toContain('diff-body')
    expect(markup).toContain('diff-line')
    expect(markup).not.toContain('timeline-tool__diff-row')
  })

  it('屏幕上一个滚动出口：横条不归行带自己', () => {
    const markup = markupOf(AFTER)

    /* 行带自己横滚会让同一件事出现两条横条，所以抽屉里关掉。 */
    expect(markup).not.toContain('overflow-x-auto')
    /* 自绘的伪滚动条（range input）不再有。 */
    expect(markup).not.toContain('timeline-tool__diff-scrollbar')
    expect(markup).not.toContain('type="range"')
    /* 双轴滚动归那一格自己，它仍戴着嵌套滚动的标记。 */
    expect(markup).toContain('data-scrollable')
  })

  it('抽屉里不画折叠带，也没有占位记号', () => {
    const markup = markupOf(AFTER)

    /*
     * 这一处改动只取三行上下文（file-diff.ts 的 computeFile），跳过的行从没进过这份
     * 模型：那条「N unmodified lines」既展不开也说不明什么，只是两行之间的一句废话。
     */
    expect(markup).not.toContain('unmodified lines')
    expect(markup).not.toContain('diff-gap')
    /* 折叠带那类没有行号的行曾印一个「⋯」占位，是第二种说法。 */
    expect(markup).not.toContain('⋯')
  })

  it('抽屉里的正文过了着色器：片段带语法色', async () => {
    /*
     * 这是那次「diff 一片黑」的回归判据。
     *
     * 行模型来自 computeFile，它只切行、不认语法，片段 color 恒为 null —— 审查面板有
     * worker 替它跑着色器（review 包的 derive.worker.ts），抽屉没有，于是整片是黑的。
     * 修法是抽屉就地跑同一份 paint()（diff-painting.ts），所以这里钉的是管线本身：
     * computeFile → paint 之后，同一行必须切出多个带色的片段。
     */
    const file = computeFile('src/bridge.ts', CODE, CODE_AFTER)
    const before = file.rows.flatMap((row) => row.pieces)

    expect(before.length).toBeGreaterThan(0)
    expect(before.every((piece) => piece.color === null)).toBe(true)

    const painted = await paint([file])
    const added = painted[0]?.rows.find((row) => row.kind === 'added')

    if (added === undefined) {
      throw new Error('着色后的行带里没有 added 行')
    }

    const coloured = added.pieces.filter((piece) => piece.color !== null)

    /* 一行里切出多段、颜色不止一种，才是语法着色而不是整行一个色。 */
    expect(coloured.length).toBeGreaterThan(1)
    expect(new Set(coloured.map((piece) => piece.color?.light)).size).toBeGreaterThan(1)
    /* 切分只是换色：拼回来仍与原文一字不差。 */
    expect(added.pieces.map((piece) => piece.text).join('')).toBe(added.text)
  })
})

describe('抽屉的 CSS 不再重抄行带', () => {
  it('增删底色与行号槽归行带自己，抽屉不声明第二份', () => {
    for (const selector of [
      '.timeline-tool__diff-row',
      '.timeline-tool__diff-line',
      '.timeline-tool__diff-code',
      '.timeline-tool__diff-scrollbar',
    ]) {
      expect(CSS).not.toContain(selector)
    }
  })

  it('diff 那一格是唯一的双轴滚动容器', () => {
    const at = CSS.indexOf('.timeline-tool__diff {')
    const close = CSS.indexOf('}', at)
    const rule = CSS.slice(at, close)

    expect(rule).toContain('overflow: auto')
    expect(rule).toContain('max-block-size')
  })
})
