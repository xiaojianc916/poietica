import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { SessionUsage } from '../../../shared/model/usage'
import { ContextGauge } from '../context-gauge'

/* U-04：斜杠命令 `/context` 等于点开上下文胶囊 —— 请求号一变就打开明细面板；还没有读数就不开。 */
afterEach(cleanup)

const usage: SessionUsage = {
  used: 53_710,
  size: 200_000,
  inputOther: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
  breakdown: {
    systemPrompt: 9_120,
    systemContext: 2_040,
    systemTools: 4_310,
    skills: 1_960,
    messages: 36_280,
    free: 116_290,
    autoCompactBuffer: 30_000,
  },
}

describe('上下文面板的外部打开', () => {
  test('请求号一变就打开明细；没变就不开', async () => {
    const view = render(<ContextGauge usage={usage} />)
    expect(screen.queryByText('系统提示词')).toBeNull()

    await act(async () => {
      view.rerender(<ContextGauge openRequest={1} usage={usage} />)
    })
    expect(screen.getByText('系统提示词')).toBeDefined()
    /* 面板只读：底部那一排压缩 / 瘦身 / 交接已删，命令仍只能从草稿里的 `/` 走 */
    expect(screen.queryByRole('button', { name: '压缩' })).toBeNull()
  })

  test('还没有读数：胶囊不画，请求也不开面板', async () => {
    const view = render(<ContextGauge />)
    await act(async () => {
      view.rerender(<ContextGauge openRequest={1} />)
    })
    expect(screen.queryByText('系统提示词')).toBeNull()
  })
})
