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
    /* 第 1 步之后挂在外层窗口（.rolling-line），第 5 步之后挂在每一句自己的窗口
       （.ticker-window[data-scrolled]）。两处都行，共同点是「窗口」而非「字」。 */
    expect(
      MASKED.filter(
        (rule) => !rule.selector.startsWith('.rolling-line') && !rule.selector.startsWith('.ticker-window['),
      ).map((rule) => rule.selector),
    ).toEqual([])
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
})
