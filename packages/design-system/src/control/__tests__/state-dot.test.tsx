import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { StateDot, type StateDotState } from '../state-dot'

/*
 * 状态点是侧栏那几行的全部状态语言：五档里四档是实心点、ongoing 是唯一一圈在转的环。
 * 这里钉的是形状与语义的对应 —— 画错的点不会让任何测试变红，只会让屏幕上「在跑」与
 * 「完事了」长得一样。
 */

afterEach(cleanup)

describe('StateDot', () => {
  test.each(['done', 'warning', 'error', 'idle'] as const)('%s 是实心点，主题色由 data-state 决定', (state) => {
    const { container } = render(<StateDot state={state} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.tagName).toBe('SPAN')
    expect(dot.dataset.state).toBe(state)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    expect(dot.style.width).toBe('10px')
  })

  test('ongoing 是一圈 14px 的环：底环 + 一段弧，不是实心点', () => {
    const { container } = render(<StateDot state="ongoing" />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.tagName.toLowerCase()).toBe('svg')
    expect(ring.dataset.state).toBe('ongoing')
    /* 尺寸走内联 style（表现属性那份被 :where(svg) 压住，Q53 清理时删除），style 才是生效通道。 */
    expect(ring.style.width).toBe('14px')
    expect(ring.getAttribute('viewBox')).toBe('0 0 24 24')
    const circles = ring.querySelectorAll('circle')
    expect(circles).toHaveLength(2)
    expect(ring.querySelector('g')).not.toBeNull()
  })

  test('尺寸可以覆盖：环与点都按 size 画', () => {
    const { container, rerender } = render(<StateDot size={8} state="done" />)
    expect((container.firstElementChild as HTMLElement).style.width).toBe('8px')

    rerender(<StateDot size={8} state="ongoing" />)
    expect((container.firstElementChild as SVGSVGElement).style.width).toBe('8px')
  })

  test('五档的 data-state 都写在自己那一个元素上（样式靠它取色）', () => {
    for (const state of ['done', 'warning', 'ongoing', 'error', 'idle'] as const satisfies readonly StateDotState[]) {
      const { container, unmount } = render(<StateDot state={state} />)
      expect((container.firstElementChild as HTMLElement).dataset.state).toBe(state)
      unmount()
    }
  })
})
