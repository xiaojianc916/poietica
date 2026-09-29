import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 横幅的两条时间约定。
 *
 * 起因：停留时长有两个读者 —— 组件里那个 setTimeout（决定几时卸载），和样式表里
 * 淡出动画的 delay（决定几时开始淡）。两边写的是同一个数，但一个在 .tsx、一个在
 * .css，改一处不改另一处，屏幕上的结果就是横幅淡到一半被抽掉，或者淡完了还挂着。
 *
 * 这里不测渲染（横幅 Portal 到 body，静态渲染里一个字都看不见，而本仓没有真 DOM
 * 测试基建）。测的是那份「两处必须一致」的文本契约：它不需要 DOM 就测得动 —— 正本
 * 的注释里把这条写成了纪律，纪律没人执行就等于没有。
 */

const here = dirname(fileURLToPath(import.meta.url))
const controlDir = join(here, '..', 'control')

const component = readFileSync(join(controlDir, 'banner.tsx'), 'utf8')
const stylesheet = readFileSync(join(controlDir, 'banner.css'), 'utf8')

const numberIn = (source: string, pattern: RegExp, what: string) => {
  const captured = pattern.exec(source)?.[1]

  if (captured === undefined) {
    throw new Error(`${what} 应当可解析`)
  }

  return Number(captured)
}

const FADE_MS = numberIn(component, /const FADE_MS = (\d+)/u, 'FADE_MS')
const HOLD_MS = numberIn(component, /const HOLD_MS = (\d+)/u, 'HOLD_MS')

describe('横幅的时间契约', () => {
  it('淡出时长两侧一致:组件卸载与样式表淡出不能各说各话', () => {
    /* 样式表里只该有一处 banner-fade 的时长声明，且它等于 FADE_MS。 */
    const declared = [...stylesheet.matchAll(/ui-banner-fade (\d+)ms/gu)].map((m) => Number(m[1]))

    expect(declared.length, 'banner-fade 的时长声明处数').toBeGreaterThanOrEqual(1)

    for (const value of declared) {
      expect(value, 'banner-fade 时长').toBe(FADE_MS)
    }
  })

  it('停留时长只有一条真身:样式表读变量,不回退成另一个数', () => {
    /*
     * 样式表必须读 --ui-banner-hold，而且它的回退值必须与组件的默认值相等 ——
     * 回退是「没传时用什么」，不是「另一份默认值」，两者一旦分叉，属性没设上时
     * 就会用错的那一个。
     */
    const fallbacks = [...stylesheet.matchAll(/var\(--ui-banner-hold,\s*(\d+)ms\)/gu)].map((m) =>
      Number(m[1]),
    )

    expect(fallbacks.length, '读 --ui-banner-hold 的处数').toBeGreaterThanOrEqual(2)

    for (const value of fallbacks) {
      expect(value, '--ui-banner-hold 的回退值').toBe(HOLD_MS)
    }
  })

  it('组件把停留时长传给样式表,而不是只留给自己', () => {
    expect(component).toContain("'--ui-banner-hold'")
    expect(component).toContain('holdMs + FADE_MS')
  })
})
