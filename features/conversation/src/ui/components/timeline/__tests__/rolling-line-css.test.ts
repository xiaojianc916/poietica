import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * 组头那一格遮罩的护栏（思考行 T-01、T-02）。
 *
 * 遮罩的坐标系必须是**看得见的那一段窗口**，不能是字。字那一层是 inline-size: max-content
 * 的自然宽度，而窗口又被滚到了句末 —— 渐隐于是正好落在两端：右端是最新的字（人在等的就是
 * 它），左端是早已划走的句首，而窗口左缘那个字是满墨的，被 overflow: hidden 硬切成半个。
 *
 * 所以这张表里只允许两件事：遮罩挂在窗口上；右端永远满墨。
 *
 * 这里读的是样式表的文本，不是渲染结果 —— happy-dom 没有真实布局，量不出遮罩落在哪。
 */

const CSS = readFileSync(fileURLToPath(new URL('../rolling-line.css', import.meta.url)), 'utf8')

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

    if (open < 0) break

    const close = text.indexOf('}', open)

    if (close < 0) break

    const prelude = text.slice(at, open)

    /* 取前奏里最后一段当选择器：@media 这类嵌套的前面那截是条件，不是选择器。 */
    rules.push({ selector: prelude.slice(prelude.lastIndexOf('{') + 1).trim(), body: text.slice(open + 1, close) })
    at = close + 1
  }

  return rules
}

const RULES = rulesOf(CSS)
/** 挂遮罩的那些块：整张表里就这几处，下面每一条断言都围着它们。 */
const MASKED = RULES.filter((rule) => rule.body.includes('mask-image'))
/** 印字的那两层：遮罩落在这上面就正是 T-01、T-02 的根因。 */
const PRINTING = RULES.filter(
  (rule) => rule.selector.includes('rolling-line__text') || rule.selector.includes('ticker-track'),
)

describe('组头那一格的遮罩', () => {
  it('挂在窗口上，不挂在字上', () => {
    expect(MASKED.length).toBeGreaterThan(0)
    expect(MASKED.map((rule) => rule.selector)).toEqual(['.ticker-window[data-scrolled]'])
  })

  it('印字那一层与轨道都不许自己戴遮罩', () => {
    expect(PRINTING.length).toBeGreaterThan(0)
    expect(PRINTING.filter((rule) => rule.body.includes('mask-image')).map((rule) => rule.selector)).toEqual([])
  })

  it('右端永远满墨：渐变收在 #000 100%，不收在 transparent', () => {
    for (const rule of MASKED) {
      expect(rule.body).toContain('to right')
      expect(rule.body).toContain('#000 100%')
      expect(rule.body).not.toContain('transparent 100%')
    }
  })

  it('淡出只在「已经往左划过」时出现：静止的短句没有雾', () => {
    /* 挂在 [data-scrolled] 上而不是无条件挂在窗口上 —— 短句没划过，左边不该化开。 */
    expect(CSS).toContain('.ticker-window[data-scrolled]')
    expect(CSS).not.toMatch(/\.ticker-window\s*\{[^}]*mask-image/u)
  })

  it('行高仍然钉死一行：这些行挂着虚拟器的 measureElement', () => {
    const line = RULES.find((rule) => rule.selector === '.rolling-line')

    expect(line?.body).toContain('block-size: 1lh')
    expect(line?.body).toContain('overflow: hidden')
  })

  it('常驻的 will-change 不许有：每行一层合成层', () => {
    const moving = RULES.filter((rule) => rule.body.includes('will-change'))

    /* 只允许挂在那一个按需写的属性上。 */
    expect(moving.map((rule) => rule.selector)).toEqual(['.ticker-track[data-moving]'])
  })
})
