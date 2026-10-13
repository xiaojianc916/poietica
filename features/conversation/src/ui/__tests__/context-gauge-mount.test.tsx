import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionUsage } from '../agent/usage'
import { ContextGauge } from '../components/composer/context-gauge'

/* 提示与面板是两个触发器挂在同一个按钮上，只有面板、没有提示就是退掉了原来那一格。 */

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

    expect(markup).toContain('context-gauge__trigger')
    expect(markup).toContain('上下文已用 70%')
    expect(markup).toContain('context-gauge__ring')
  })

  test('还没报过用量就整个不画', () => {
    expect(renderToStaticMarkup(<ContextGauge usage={undefined} />)).toBe('')
  })

  test('窗口为零时不画，不除零', () => {
    expect(renderToStaticMarkup(<ContextGauge usage={{ ...usage(null), size: 0 }} />)).toBe('')
  })
})
