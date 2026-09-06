import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/*
 * 表格行线读的是哪一档。
 *
 * 这条断言原本和 @poietica/design-system 的主题契约挤在根 tests/unit/ 的同一个文件里，
 * 靠 join(repoRoot, 'agent', 'ui', …) 跨包摸文件 —— 目录一动就 ENOENT。
 * 它断言的其实是本包自己的 CSS 指向哪个 token，不需要读别人的文件，
 * 所以它属于这里。
 */

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

const declOf = (css: string, name: string) => {
  const captured = new RegExp(`^\\s*${name}:\\s*([^;]+);$`, 'm').exec(css)?.[1]

  if (captured === undefined) {
    throw new Error(`${name} 应当可解析`)
  }

  return captured.trim()
}

const metrics = stripComments(
  readFileSync(new URL('../composer-metrics.css', import.meta.url), 'utf8'),
)

describe('composer metrics contract', () => {
  it('表格行线读卡内线那一档，不自己定一个灰', () => {
    expect(declOf(metrics, '--cp-hairline')).toBe('var(--ui-divider-subtle)')
  })
})
