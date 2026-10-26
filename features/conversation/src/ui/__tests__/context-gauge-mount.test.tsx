import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextGauge } from '../composer/view/context-gauge'
import type { SessionUsage } from '../shared/model/usage'

/* 提示与面板是两个触发器挂在同一个按钮上，只有面板、没有提示就是退掉了原来那一格。 */

const usage = (breakdown: SessionUsage['breakdown']): SessionUsage => ({
  used: 140_000,
  size: 200_000,
  breakdown,
  tokens: null,
})

describe('上下文胶囊的触发方式', () => {
  test('常显触发按钮，带可读用量与展开语义', () => {
    const markup = renderToStaticMarkup(<ContextGauge usage={usage(null)} />)

    expect(markup).toContain('aria-label="上下文已用 70%"')
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(markup).toContain('<svg')
  })

  test('还没报过用量就整个不画', () => {
    expect(renderToStaticMarkup(<ContextGauge usage={undefined} />)).toBe('')
  })

  test('窗口为零时不画，不除零', () => {
    expect(renderToStaticMarkup(<ContextGauge usage={{ ...usage(null), size: 0 }} />)).toBe('')
  })
})
