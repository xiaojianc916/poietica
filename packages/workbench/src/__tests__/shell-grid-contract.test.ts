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
})
