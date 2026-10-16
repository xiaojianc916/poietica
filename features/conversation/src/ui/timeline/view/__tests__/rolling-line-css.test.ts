import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* 组头那一格的样式护栏（思考行 v2）：happy-dom 没有布局，只能读样式表文本，钉住几条「一改就
 * 回到 v1」的规则；真实布局由 tooling/checks/ticker-layout 验证。 */

const CSS = readFileSync(fileURLToPath(new URL('../ticker/rolling-line.css', import.meta.url)), 'utf8')

interface Rule {
  readonly selector: string
  readonly body: string
}

/** 剥注释再切块：注释里的花括号会让块界算错。 */
function rulesOf(css: string): Rule[] {
  const text = css.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  const rules: Rule[] = []
  let at = 0

  for (;;) {
    const open = text.indexOf('{', at)
    const close = open < 0 ? -1 : text.indexOf('}', open)

    if (close < 0) break

    rules.push({ selector: text.slice(at, open).trim(), body: text.slice(open + 1, close) })
    at = close + 1
  }

  return rules
}

const RULES = rulesOf(CSS)

function declaredValue(selector: string, property: string): string | undefined {
  let value: string | undefined

  for (const rule of RULES) {
    if (!rule.selector.split(',').some((part) => part.trim() === selector)) continue

    for (const declaration of rule.body.split(';')) {
      const [name, ...rest] = declaration.split(':')

      if (name?.trim() === property) value = rest.join(':').trim()
    }
  }

  return value
}

describe('rolling-line.css', () => {
  test('没有任何遮罩或渐隐：左边缘直接裁，右边缘不遮', () => {
    const code = CSS.replaceAll(/\/\*[\s\S]*?\*\//gu, '')

    expect(code).not.toMatch(/mask/u)
    expect(code).not.toMatch(/data-scrolled/u)
    expect(code).not.toMatch(/--cp-ticker-fade/u)
  })

  test('工具行与落定态：从头显示，放不下时末尾省略号', () => {
    for (const scope of ['.rolling-line[data-variant="tool"]', '.rolling-line:not([data-following])']) {
      expect(declaredValue(`${scope} .ticker-window`, 'justify-content')).toBe('flex-start')
      expect(declaredValue(`${scope} .ticker-track`, 'text-overflow')).toBe('ellipsis')
      expect(declaredValue(`${scope} .ticker-track`, 'overflow')).toBe('hidden')
      expect(declaredValue(`${scope} .ticker-track`, 'padding-inline-end')).toBe('0')
    }
  })

  test('高度钉死一行：虚拟列表的测量不会因为这一格抖动', () => {
    expect(declaredValue('.rolling-line', 'block-size')).toBe('1lh')
    expect(declaredValue('.rolling-line', 'overflow')).toBe('hidden')
  })
})
