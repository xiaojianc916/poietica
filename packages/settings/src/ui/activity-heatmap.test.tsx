import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityHeatmap } from './activity-heatmap'

/*
 * 守的是「提示走设计系统的气泡」这一条：格子不能再带原生 title —— 原生气泡的字体、
 * 配色、延时都不归我们管，与同一页里别处的气泡长得不一样。
 *
 * 用 react-dom/server 而不是 testing-library：要守的只关乎一次渲染的产物，不需要
 * 一个 DOM；气泡挂在 Portal 上，本来也不在这次渲染里。
 */
const DAYS = [
  { date: '2026-08-29', count: 0 },
  { date: '2026-08-30', count: 33028 },
]

describe('热力图', () => {
  it('格子不带原生 title', () => {
    expect(renderToStaticMarkup(<ActivityHeatmap days={DAYS} />)).not.toContain('title=')
  })

  /* 只有有账的那一格是触发器；空格子连触发器都不装。 */
  it('有账可记的格子挂上设计系统的气泡', () => {
    const markup = renderToStaticMarkup(<ActivityHeatmap days={DAYS} />)

    expect(markup.match(/data-base-ui-tooltip-trigger/g)).toHaveLength(1)
  })
})
