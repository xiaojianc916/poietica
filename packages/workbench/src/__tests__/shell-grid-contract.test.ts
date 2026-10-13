import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 外壳栅格的分隔线行号必须落在主体那一行（真实故障：栅格从三行变两行后分隔线仍写着 `grid-area: 3 / …`，
 * 起点与终点同为末线、跨度归零，真机 Chromium 实测 getBoundingClientRect().height === 0）。
 * happy-dom 不做布局量不出来，所以这里钉住那份文本契约。
 */

const here = dirname(fileURLToPath(import.meta.url))
const styles = readFileSync(join(here, '..', 'styles.css'), 'utf8')

function dividerRows(source: string): number[] {
  return [...source.matchAll(/grid-area:\s*(\d+)\s*\//gu)].map((m) => Number(m[1]))
}

/* 取一条规则的正文；找不到交回 undefined，调用方给出「哪一条缺了」。 */
function ruleOf(source: string, selector: string): string | undefined {
  const escaped = selector.replaceAll('.', '\\.')
  const pattern = `${escaped}\\s*\\{[^}]*\\}`
  return new RegExp(pattern, 'u').exec(source)?.[0]
}

describe('外壳栅格的行契约', () => {
  test('分隔线的起始行不越过栅格：两行制下主体是第 2 行', () => {
    const rows = dividerRows(styles)
    expect(rows.length, '分隔线的处数').toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      /* 起点必须真的存在：等于行数 + 1 就是末线，跨度归零。 */
      expect(row, '分隔线的起始行').toBe(2)
    }
  })

  test('浮层包装层不生成盒子（否则会被栅格自动放进格位）', () => {
    const parts = readFileSync(join(here, '..', 'parts.css'), 'utf8')
    const rule = /\.workbench__overlay\s*\{[^}]*\}/u.exec(parts)?.[0]
    expect(rule, '.workbench__overlay 规则').toBeDefined()
    expect(rule).toContain('display: contents')
  })

  /*
   * 侧栏面板的高度链（真实故障：legacy 的 .assistant-panel 框随组件一起删掉后，面板格只剩
   * `min-height: 0` 的块盒，会话列表的 block-size: 100% 解到 auto —— 会话一多，下面几条被
   * overflow: hidden 裁掉，既不滚也看不到）。这条链断在哪一环都不报错，只是静默不滚，
   * happy-dom 又不做布局，所以钉住文本契约。
   */
  test('侧栏面板格是吃剩余高度的 flex 列，列表才算得出高度', () => {
    const parts = readFileSync(join(here, '..', 'parts.css'), 'utf8')
    const host = ruleOf(parts, '.workbench__sidebar-panels')
    const section = ruleOf(parts, '.workbench__sidebar-section')

    for (const [name, rule] of [
      ['宿主格', host],
      ['面板格', section],
    ] as const) {
      expect(rule, `${name} 规则`).toBeDefined()
      expect(rule, `${name} 的 display`).toContain('display: flex')
      expect(rule, `${name} 的 flex-direction`).toContain('flex-direction: column')
      expect(rule, `${name} 的 min-height`).toContain('min-height: 0')
    }

    /* 只有面板格吃剩余空间：滚动发生在列表里，不在宿主这一格。 */
    expect(section, '面板格的 flex').toContain('flex: 1 1 0')
  })
})
