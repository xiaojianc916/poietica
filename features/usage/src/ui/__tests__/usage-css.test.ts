import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

/*
 * 用量页那几张图的样子由 design-system 的 settings.css 一处持有，而这个包（features/usage）
 * 看不见它 —— 样式在别的包里，样式出了事却没有一条用例会红。
 *
 * 2026-10-07 产品负责人报障：用量页整个坏掉 —— 趋势图是一块黑斑、七个日期飘到设置页
 * 最顶上、概览六个读数挤成一片小字。逐条查源后确认全是**这一份表里漏掉的规则**：
 *
 *   .settings-trend__line        → 漏 fill: none，<path> 默认黑填充把曲线涂成一块
 *   .settings-trend__axis        → 漏 position: relative，绝对定位的日期一路逃到 .settings-content
 *   .settings-metric__value      → 漏字号/字重，22px 的读数退回与正文同档
 *   .settings-trend__swatch      → 漏尺寸与 0 档底色，第一个模型的图例是一条空行
 *   .settings-heatmap__legend .settings-heatmap__cell → 漏宽度，图例方块塌成 0 宽
 *
 * 这些类名在别的地方也有定义（例如 [data-series="1..5"] 的底色），所以「搜得到这个名字」
 * 不等于「这一条在」。用例因此逐条断言**那一条规则本身**。
 *
 * 读的是 design-system 的相对路径而不是从仓库根伸手：被测物搬到哪，它跟到哪
 * （与 design-system 的 theme-contract.test.ts 同一条教训）。
 */
const CSS = readFileSync(new URL('../../../../../packages/design-system/src/settings.css', import.meta.url), 'utf8')
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取某个选择器的规则正文；没有这条规则就交 null。 */
function ruleOf(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = STRIPPED.match(new RegExp(`(?:^|[}])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))

  return found?.[1] ?? null
}

/** 规则正文里的某条声明（含值），没有就交 null。 */
function declOf(selector: string, property: string): string | null {
  const body = ruleOf(selector)

  if (body === null) {
    return null
  }

  const found = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'm'))

  return found?.[1]?.trim() ?? null
}

describe('用量页的样式（报障回归）', () => {
  /* 这一条就是那块黑斑：<path> 不写 fill: none 会被浏览器当闭合多边形涂满。 */
  it('折线不填充（不然趋势图是一块黑斑）', () => {
    expect(declOf('.settings-trend__line', 'fill')).toBe('none')
  })

  it('折线有描边宽度与抗拉伸（viewBox 1000 宽再横向拉伸）', () => {
    expect(declOf('.settings-trend__line', 'stroke-width')).toBe('2')
    expect(declOf('.settings-trend__line', 'vector-effect')).toBe('non-scaling-stroke')
  })

  /* 日期是绝对定位的 span，容器不定位就一路往上找到 .settings-content。 */
  it('横轴容器是定位锚（不然日期飘到设置页最顶上）', () => {
    expect(declOf('.settings-trend__axis', 'position')).toBe('relative')
  })

  it('横轴刻度自己绝对定位并居中', () => {
    expect(declOf('.settings-trend__axis span', 'position')).toBe('absolute')
    expect(declOf('.settings-trend__axis span', 'transform')).toBe('translateX(-50%)')
  })

  it('概览读数是加大字号（不是与正文同档的小字）', () => {
    expect(declOf('.settings-metric__value', 'font-size')).toBe('22px')
    expect(declOf('.settings-metric__value', 'font-weight')).toBe('550')
  })

  it('没读数的那一格用占位符色、字重退回常规', () => {
    expect(declOf('.settings-metric__value[data-unrecorded="true"]', 'color')).toBe('var(--ui-placeholder)')
    expect(declOf('.settings-metric__value[data-unrecorded="true"]', 'font-weight')).toBe('400')
  })

  /* 只定义了 [data-series="1..5"]，0 档那一条与尺寸都落在这条里。 */
  it('图例色块自带尺寸与 0 档底色', () => {
    expect(declOf('.settings-trend__swatch,\n.settings-trend__dot', 'inline-size')).toBe('10px')
    expect(declOf('.settings-trend__swatch,\n.settings-trend__dot', 'background')).toBe('var(--settings-series-0)')
  })

  /* 图例方块不在栅格里，宽度得自己给；高度由 aspect-ratio 跟上。 */
  it('热力图图例方块有宽度', () => {
    expect(declOf('.settings-heatmap__legend .settings-heatmap__cell', 'inline-size')).toBe(
      'var(--settings-heat-swatch)',
    )
  })

  /* 一列一周是这张图的语义：行优先会把一周铺成横排。 */
  it('热力图按列优先铺格', () => {
    expect(declOf('.settings-heatmap__grid', 'grid-auto-flow')).toBe('column')
  })

  /* 深浅两支都写全，不依赖样式表先后。 */
  it('趋势图气泡在深色下不反色', () => {
    expect(declOf(':root[data-theme="dark"] .settings-trend__hint', 'background')).toBe('#121212')
  })
})
