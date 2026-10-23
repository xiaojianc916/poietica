import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * 状态点的颜色与动效只写在样式表里：单测环境没有布局、也解析不了 CSS Modules，组件测试
 * 读不到「这一档到底画成什么颜色」。少了某一条规则，点会安静地落回继承色，屏幕上「警告」
 * 与「空闲」长得一样 —— 组件测试全绿也发现不了。
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'state-dot.css'), 'utf8')

describe('state-dot.css', () => {
  test.each(['done', 'warning', 'error', 'idle'] as const)('%s 有自己的颜色规则', (state) => {
    expect(css).toContain(`.ui-state-dot[data-state='${state}']`)
  })

  test('完成走成功色、等待走警告色、出错走危险色、空闲走中性档', () => {
    expect(css).toMatch(/\.ui-state-dot\[data-state='done'\][^{]*\{[^}]*--ui-success/su)
    expect(css).toMatch(/\.ui-state-dot\[data-state='warning'\][^{]*\{[^}]*--ui-warning/su)
    expect(css).toMatch(/\.ui-state-dot\[data-state='error'\][^{]*\{[^}]*--ui-destructive/su)
    expect(css).toMatch(/\.ui-state-dot\[data-state='idle'\][^{]*\{[^}]*--ui-muted-foreground/su)
  })

  test('ongoing 是转动的环，不是第四个实心点', () => {
    expect(css).not.toContain(".ui-state-dot[data-state='ongoing']")
    expect(css).toContain('.ui-state-dot__track')
    expect(css).toContain('.ui-state-dot__arc')
    expect(css).toContain('@keyframes ui-state-dot-spin')
    expect(css).toContain('@keyframes ui-state-dot-dash')
    expect(css).toMatch(/\.ui-state-dot__motion[^{]*\{[^}]*animation: ui-state-dot-spin 1\.5s linear infinite/su)
    expect(css).not.toMatch(/\.ui-state-dot--ongoing\s*\{[^}]*animation:/su)
    /* 底环淡一档、弧的呼吸从 12/150 到 24/150，与 DSH 的 StateDot 同一条曲线。 */
    expect(css).toContain('stroke-dasharray: 12 150')
    expect(css).toContain('stroke-dasharray: 24 150')
    expect(css).toContain('stroke-dashoffset: -6')
  })

  test('减少动效时停转，但留一段中间长度的弧，仍看得出「在跑」', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.ui-state-dot__motion,')
    expect(reduced).toContain('.ui-state-dot__arc')
    expect(reduced).toContain('animation: none')
    expect(reduced).toContain('stroke-dasharray: 18 150')
  })
})
