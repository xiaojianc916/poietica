import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 外壳栅格的**行数**与**分隔线行号**必须一致。
 *
 * 起因（真实故障，2026-10-06）：横幅行删掉之后栅格从三行变两行，而两条分隔线仍写着
 * `grid-area: 3 / …` —— 两行制里 line 3 就是末线，起点与终点同为 3，跨度归零，分隔线
 * 整条消失（真机 Chromium 实测 getBoundingClientRect().height === 0）。这类错误在
 * happy-dom 里量不出来（它不做布局），所以这里钉住那份**文本契约**。
 *
 * 判据取自 legacy：`apps/desktop/src/shell/layout/workspace-shell.css` 也是两行栅格，
 * 它的分隔线写的就是第 2 行。
 */

const here = dirname(fileURLToPath(import.meta.url))
const styles = readFileSync(join(here, '..', 'styles.css'), 'utf8')

/** grid-template-areas 里声明了几行（每个带引号的字符串是一行）。 */
function declaredRows(source: string): number {
  const block = /grid-template-areas:\s*([^;]+);/u.exec(source)?.[1]
  if (block === undefined) throw new Error('grid-template-areas 应当可解析')
  return [...block.matchAll(/"([^"]+)"/gu)].length
}

/** 每条 grid-area 的起始行号（只取 `N / …` 那种纯数字写法）。 */
function dividerRows(source: string): number[] {
  return [...source.matchAll(/grid-area:\s*(\d+)\s*\//gu)].map((m) => Number(m[1]))
}

describe('外壳栅格的行契约', () => {
  test('栅格只有「页头 / 主体」两行（横幅行已删除）', () => {
    expect(declaredRows(styles)).toBe(2)
    /* 命名区域里不该再有 banners。 */
    expect(styles).not.toContain('"banners')
  })

  test('分隔线的起始行不越过栅格：两行制下主体是第 2 行', () => {
    const rows = dividerRows(styles)
    expect(rows.length, '分隔线的处数').toBeGreaterThanOrEqual(2)
    for (const row of rows) {
      /* 起点必须是主体那一行（第 2 行），且必须真的存在 —— 等于行数 + 1 就是末线，跨度归零。 */
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
