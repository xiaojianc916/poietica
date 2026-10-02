import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * 公式的溢出出口。
 *
 * 两条都是实测出来的：拿真实的 KaTeX 构建渲染十几种上下限形态，量 scrollWidth/clientWidth
 * 与 scrollHeight/clientHeight，再按 computed 的 overflow 判裁切。这一条钉的是那次结果 ——
 *
 * 1. `.katex-display` 必须给纵向留出余量（padding-block），否则 overflow-y: hidden 会把
 *    KaTeX 画在内容盒之外的上下限裁掉：分式、根号、积分号的上下限全都超框，实测最大
 *    溢出 5px，症状就是「公式高一点就在上面被截断」。
 *    注意 overflow-y: visible 不是解 —— 与 overflow-x: auto 同用时会被规范强制算成 auto，
 *    实测 computed 值确实是 auto，纵向反而多出一个滚动容器。
 *
 * 2. 行内公式**不能**持有滚动盒。挂上 overflow-x: auto 之后，`\colorbox` / `\fcolorbox` /
 *    长行内式的 scrollWidth 会比 clientWidth 多 2px，那 2px 就变成一根横杠 —— 屏幕上
 *    「莫名其妙出现左右滑动条」。行内公式参与行内排版，不该自己开滚动条。
 *
 * 自检跑法：bun test src/__tests__/katex-overflow-shape.test.ts
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../surface/timeline/timeline.css', import.meta.url)),
  'utf8',
)

/** 一条规则的声明块。选择器写多长都行，取到第一个 `}` 为止。 */
function ruleFor(selector: string): string {
  const at = CSS.indexOf(selector)

  expect(at).toBeGreaterThan(-1)

  const open = CSS.indexOf('{', at)
  const close = CSS.indexOf('}', open)

  return CSS.slice(open + 1, close)
}

describe('公式的溢出出口', () => {
  it('行间公式给纵向留余量，否则上下限会被裁掉', () => {
    const display = ruleFor('.timeline-prose .katex-display {')

    /* 横向的滚动权归它自己：一条长推导可以真的超出正文宽度。 */
    expect(display).toContain('overflow-x: auto')
    /* 纵向的余量是 padding 给的，不是 overflow —— 后者与 auto 同用会被强制成 auto。 */
    expect(display).toContain('padding-block:')
    expect(display).not.toContain('overflow-y: visible')
  })

  it('行内公式不持有滚动盒', () => {
    const inline = ruleFor('.timeline-prose :not(.katex-display) > .katex {')

    /* 它是行内排版的一部分：放不下时该换行的是这一行，不是它自己开滚动条。 */
    expect(inline).not.toContain('overflow-x')
    expect(inline).not.toContain('overflow-y')
    expect(inline).toContain('display: inline-block')
    expect(inline).toContain('max-inline-size: 100%')
  })

  it('公式不参与任意处断行', () => {
    const reset = ruleFor('.timeline-prose :is(.katex, .katex-display) {')

    expect(reset).toContain('overflow-wrap: normal')
    expect(reset).toContain('word-break: normal')
  })
})
