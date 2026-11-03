import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ThreadDisclosure } from '../thread-disclosure'

/*
 * 展开壳从「motion 补 height」换成「CSS 补 grid-template-rows」后，行为契约不能变：
 * 收起时内容不挂 DOM（几百条会话的列不能替看不见的内容付挂载），打开时内容出现，
 * 收起动画期间内容还在但已 inert，动画走完再摘掉。
 *
 * 收起结束由壳自己的 transitionend 报告，测试直接派发这个事件：断言在同一个同步步里完成，
 * 不把闸门的稳定性押在 140ms 的计时器上（全量 `bun test` 并发下它会拖到几十秒）。
 */

afterEach(cleanup)

function content(isOpen: boolean) {
  return (
    <ThreadDisclosure isOpen={isOpen}>
      <button type="button">会话一</button>
    </ThreadDisclosure>
  )
}

function mount(isOpen: boolean) {
  return render(content(isOpen))
}

/*
 * happy-dom 没有 TransitionEvent（`fireEvent.transitionEnd` 会退化成不带 propertyName 的 Event），
 * 这里自己搭一个：类型、冒泡路径与浏览器一致，只有 propertyName 是这一层关心的字段。
 */
function endTransition(element: Element, propertyName: string): void {
  const event = new Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  act(() => {
    element.dispatchEvent(event)
  })
}

describe('会话列表的展开壳', () => {
  test('收起时内容不挂 DOM', () => {
    const { container } = mount(false)

    expect(container.querySelector('.thread-disclosure')).toBeNull()
    expect(container.textContent).not.toContain('会话一')
  })

  test('打开后内容出现，data-open 在一帧后落到 true（CSS 才有起点可补）', async () => {
    const view = mount(false)
    view.rerender(content(true))

    await waitFor(() => {
      expect(view.container.querySelector('.thread-disclosure')?.getAttribute('data-open')).toBe('true')
    })
    expect(view.container.textContent).toContain('会话一')
  })

  test('收起动画期间内容还在但 inert，走完再摘掉', () => {
    const view = mount(true)
    view.rerender(content(false))

    const shell = view.container.querySelector<HTMLElement>('.thread-disclosure')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-open')).toBe('false')
    expect(shell?.inert).toBe(true)

    endTransition(shell as Element, 'grid-template-rows')
    expect(view.container.querySelector('.thread-disclosure')).toBeNull()
  })

  test('内层行的补间结束不算这一层收起结束', () => {
    const view = mount(true)
    view.rerender(content(false))
    const shell = view.container.querySelector('.thread-disclosure') as HTMLElement
    const inner = view.container.querySelector('.thread-disclosure__inner') as HTMLElement

    endTransition(inner, 'grid-template-rows')
    expect(view.container.querySelector('.thread-disclosure')).not.toBeNull()

    endTransition(shell, 'grid-template-rows')
    expect(view.container.querySelector('.thread-disclosure')).toBeNull()
  })

  test('收起动画途中又打开：内容不先被摘掉，直接回到打开态', async () => {
    const view = mount(true)
    view.rerender(content(false))
    view.rerender(content(true))

    await waitFor(() => {
      expect(view.container.querySelector('.thread-disclosure')?.getAttribute('data-open')).toBe('true')
    })
    expect(view.container.textContent).toContain('会话一')
  })
})
