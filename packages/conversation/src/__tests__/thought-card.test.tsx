import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThoughtCard } from '../surface/timeline/thought-card'
import { VIRTUAL_ABOVE_LINES } from '../surface/timeline/virtual-lines'

/*
 * 展开的推理。
 *
 * 三条：封顶自己滚、整体让开图标那一格、过长换虚拟化。前两条在样式表里，第三条在这一次
 * 渲染里 —— 样式没有测试，所以把不变量钉在源码上，改坏了是这里失败，不是等人截图。
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../surface/timeline/flow-row.css', import.meta.url)),
  'utf8',
)

function ruleFor(selector: string): string {
  const at = CSS.indexOf(selector)

  expect(at).toBeGreaterThan(-1)

  return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', CSS.indexOf('{', at)))
}

function cardOf(text: string, isOpen = true, isStreaming = false): string {
  return renderToStaticMarkup(
    createElement(ThoughtCard, { isOpen, isStreaming, onToggle: () => {}, text }),
  )
}

const SHORT = '先看目录，再读 README。\n第二行。'

describe('展开的推理', () => {
  it('封顶并自己滚，长出来的部分不推走下面', () => {
    const body = ruleFor('.timeline-thought {')

    expect(body).toContain('max-block-size: var(--cp-timeline-thought-max)')
    expect(body).toContain('overflow: auto')
  })

  it('竖线落在图标那一格，正文落在名字那一格', () => {
    const body = ruleFor('.timeline-thought {')

    /* 线在行首占 2px，正文再让开「图标 + 间隙 - 2px」，加起来正好是名字的起点。 */
    expect(body).toContain('border-inline-start: 2px solid var(--cp-hairline)')
    expect(body).toContain('padding-inline-start: calc(var(--cp-timeline-tool-indent) - 2px)')
    /* 再给一次 margin 就是两层缩进叠加，正文会比名字还右。 */
    expect(body).not.toContain('margin-inline-start')
  })

  it('短推理逐字印原文，不进虚拟化', () => {
    const markup = cardOf(SHORT)

    expect(markup).toContain('先看目录，再读 README。')
    expect(markup).not.toContain('timeline-thought__lines')
  })

  it('收起就不在 DOM 里', () => {
    expect(cardOf(SHORT, false)).not.toContain('timeline-thought')
  })

  it('过长换成按行虚拟化，只画视口里那几行', () => {
    const count = VIRTUAL_ABOVE_LINES + 200
    const text = Array.from({ length: count }, (_unused, index) => `thought-${String(index)}`).join(
      '\n',
    )
    const markup = cardOf(text)

    expect(markup).toContain('timeline-thought__lines')
    /* 开头那几行在视口里，末尾那几百行一根节点都不建。 */
    expect(markup).toContain('thought-0')
    expect(markup).not.toContain(`thought-${String(count - 1)}`)
  })

  it('虚拟化的行盒高度交给虚拟器量，不由样式写死', () => {
    /* 散文会折行，写死高度会让折行的行叠在一起。 */
    expect(ruleFor('.timeline-thought__line {')).not.toContain('block-size')
    expect(ruleFor('.timeline-thought__line {')).not.toContain('height')
  })
})
