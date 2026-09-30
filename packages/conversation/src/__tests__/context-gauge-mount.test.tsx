import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionUsage } from '../agent/usage'
import { ContextGauge } from '../surface/composer/context-gauge'

/*
 * 挂载这一层只验一件事：原来的悬浮提示没有被面板顶掉。
 *
 * 提示与面板是两个触发器挂在同一个按钮上（PopoverTrigger 交给 TooltipTrigger 的
 * render）。两者都在 DOM 里才算数 —— 只有面板、没有提示，就是退掉了原来那一格。
 *
 * 面板里的数由 gaugeLayout 的纯函数测试覆盖，这里不重复数。
 */

const usage = (breakdown: SessionUsage['breakdown']): SessionUsage => ({
  used: 140_000,
  size: 200_000,
  inputOther: 1,
  inputCacheRead: 2,
  inputCacheCreation: 3,
  breakdown,
})

describe('上下文胶囊的触发方式', () => {
  test('常显触发按钮，且提示与面板两个入口都在', () => {
    const markup = renderToStaticMarkup(<ContextGauge usage={usage(null)} />)

    /* 触发按钮：圆环 + 读数写进 aria-label。 */
    expect(markup).toContain('context-gauge__trigger')
    expect(markup).toContain('上下文已用 70%')
    /* 提示那一支仍在（原来那一格不能因为加了面板就没了）。 */
    expect(markup).toContain('context-gauge__ring')
  })

  /*
   * 圆环与正本（DSH 的 ContextMeter）逐属性同形：14 视窗、圆心 7、半径 5.5、
   * 前景用 dasharray 自顶点起画（rotate(-90 7 7)）。描边与颜色在 CSS 里，
   * 由 context-gauge.css 那两条覆盖。
   */
  test('圆环几何与正本逐属性一致', () => {
    const radius = 5.5
    const circumference = 2 * Math.PI * radius
    const markup = renderToStaticMarkup(<ContextGauge usage={usage(null)} />)

    expect(markup).toContain('viewBox="0 0 14 14"')
    expect(markup).toContain('width="14"')
    expect(markup).toContain('height="14"')
    expect(markup).toContain('cx="7"')
    expect(markup).toContain('cy="7"')
    expect(markup).toContain(`r="${radius}"`)
    expect(markup).toContain('transform="rotate(-90 7 7)"')
    /* 70% 的那一段弧，正本是 CIRCUMFERENCE*percent/100 加上整圈作间隔。 */
    expect(markup).toContain(`stroke-dasharray="${circumference * 0.7} ${circumference}"`)
  })

  test('还没报过用量就整个不画', () => {
    expect(renderToStaticMarkup(<ContextGauge usage={undefined} />)).toBe('')
  })

  test('窗口为零时不画，不除零', () => {
    expect(renderToStaticMarkup(<ContextGauge usage={{ ...usage(null), size: 0 }} />)).toBe('')
  })
})
