import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { StateDot } from '../state-dot'

/*
 * 状态点是侧栏那几行的全部状态语言：五档里四档是实心点、ongoing 是唯一一圈在转的环。
 * 这里钉的是形状与语义的对应 —— 画错的点不会让任何测试变红，只会让屏幕上「在跑」与
 * 「完事了」长得一样。颜色与动效属于样式表，不在单测里钉。
 */

afterEach(cleanup)

describe('StateDot', () => {
  test.each(['done', 'warning', 'error', 'idle'] as const)('%s 是实心点，状态写在 data-state 上', (state) => {
    const { container } = render(<StateDot state={state} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.tagName).toBe('SPAN')
    expect(dot.dataset.state).toBe(state)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  test('ongoing 是一圈环：底环 + 一段弧，不是实心点', () => {
    const { container } = render(<StateDot state="ongoing" />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.tagName.toLowerCase()).toBe('svg')
    expect(ring.dataset.state).toBe('ongoing')
    expect(ring.querySelectorAll('circle')).toHaveLength(2)
  })
})
