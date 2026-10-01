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

    /* 线在行首占一个线宽，正文再让开「图标 + 间隙 - 线宽」，加起来正好是名字的起点。 */
    expect(body).toContain(
      'border-inline-start: var(--cp-px) solid var(--cp-timeline-thought-rule)',
    )
    expect(body).toContain(
      'padding-inline-start: calc(var(--cp-timeline-tool-indent) - var(--cp-px))',
    )
    /* 线宽与让位必须是同一个令牌，写死像素会让换档时两处分叉。 */
    expect(body).not.toMatch(/border-inline-start: \d+px/)
    /* 再给一次 margin 就是两层缩进叠加，正文会比名字还右。 */
    expect(body).not.toContain('margin-inline-start')
  })

  it('短推理逐字印原文，不进虚拟化', () => {
    const markup = cardOf(SHORT)

    expect(markup).toContain('先看目录，再读 README。')
    expect(markup).not.toContain('timeline-thought__lines')
  })

  /*
   * 段间距是段与段之间的呼吸，不是行距。原文里段落之间那个空行必须自成一格，
   * 样式才有一条能落上去的规则；整段当一个文本节点时，空行由 pre-wrap 画成一整行，
   * 段间距等于行距。
   *
   * 空行里那枚 <br> 是复制用的：空盒子在选中时会被浏览器整个丢掉，选走的一段会少掉
   * 所有分段。它同时让规则多一条 :has(br) 的选择器。
   */
  it('空行自成一格，段间距归样式', () => {
    const markup = cardOf('第一段。\n\n第二段。')

    expect(markup).toContain('>第一段。</div><div class="timeline-thought__line"><br/></div>')

    const rule = ruleFor('.timeline-thought__line:empty,')

    expect(rule).toContain('block-size: var(--ui-prose-flow)')
    expect(CSS).toContain('.timeline-thought__line:has(br)')
  })

  /* 末尾换行在 pre-wrap 里不画行盒，拆成盒子后它会多占一格。 */
  it('末尾换行不多出一格', () => {
    expect(cardOf('一行。\n').match(/timeline-thought__line/g)).toHaveLength(1)
    expect(cardOf('一行。').match(/timeline-thought__line/g)).toHaveLength(1)
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

  /*
   * 正文为空时那一行只剩图标、名字与一个 2px 的点。点是「名与内容之间」的分隔，
   * 没有内容就没有它 —— 否则行尾挂着一颗孤立的白点，读起来像坏掉的字符。
   */
  it('正文为空就不画分隔点', () => {
    expect(cardOf('')).not.toContain('timeline-row__dot')
    expect(cardOf('   \n\n  ')).not.toContain('timeline-row__dot')
  })

  it('有正文时点照常是分隔符', () => {
    expect(cardOf(SHORT)).toContain('timeline-row__dot')
  })

  it('虚拟化的行盒高度交给虚拟器量，不由样式写死', () => {
    /* 散文会折行，写死高度会让折行的行叠在一起。 */
    expect(ruleFor('.timeline-thought__line {')).not.toContain('block-size')
    expect(ruleFor('.timeline-thought__line {')).not.toContain('height')
  })
})
