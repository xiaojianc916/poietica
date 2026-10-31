import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ThreadDisclosure } from '../thread-disclosure'

/*
 * 展开壳从「motion 补 height」换成「CSS 补 grid-template-rows」后，行为契约不能变：
 * 收起时内容不挂 DOM（几百条会话的列不能替看不见的内容付挂载），打开时内容出现，
 * 收起动画期间内容还在但已 inert，动画走完再摘掉。
 */

afterEach(cleanup)

function mount(isOpen: boolean) {
  return render(
    <ThreadDisclosure isOpen={isOpen}>
      <button type="button">会话一</button>
    </ThreadDisclosure>,
  )
}

describe('会话列表的展开壳', () => {
  test('收起时内容不挂 DOM', () => {
    const { container } = mount(false)

    expect(container.querySelector('.thread-disclosure')).toBeNull()
    expect(container.textContent).not.toContain('会话一')
  })

  test('打开后内容出现，data-open 在一帧后落到 true（CSS 才有起点可补）', async () => {
    const view = mount(false)
    view.rerender(
      <ThreadDisclosure isOpen>
        <button type="button">会话一</button>
      </ThreadDisclosure>,
    )

    await waitFor(() => {
      expect(view.container.querySelector('.thread-disclosure')?.getAttribute('data-open')).toBe('true')
    })
    expect(view.container.textContent).toContain('会话一')
  })

  test('收起动画期间内容还在但 inert，走完再摘掉', async () => {
    const view = mount(true)
    view.rerender(
      <ThreadDisclosure isOpen={false}>
        <button type="button">会话一</button>
      </ThreadDisclosure>,
    )

    const shell = view.container.querySelector<HTMLElement>('.thread-disclosure')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-open')).toBe('false')
    expect(shell?.inert).toBe(true)

    await waitFor(() => {
      expect(view.container.querySelector('.thread-disclosure')).toBeNull()
    })
  })

  test('收起动画途中又打开：内容不先被摘掉，直接回到打开态', async () => {
    const view = mount(true)
    view.rerender(
      <ThreadDisclosure isOpen={false}>
        <button type="button">会话一</button>
      </ThreadDisclosure>,
    )
    view.rerender(
      <ThreadDisclosure isOpen>
        <button type="button">会话一</button>
      </ThreadDisclosure>,
    )

    await waitFor(() => {
      expect(view.container.querySelector('.thread-disclosure')?.getAttribute('data-open')).toBe('true')
    })
    expect(view.container.textContent).toContain('会话一')
  })
})
