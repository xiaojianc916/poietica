import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { type ExitScheduler, ThreadDisclosure } from '../thread-disclosure'

/*
 * 展开壳从「motion 补 height」换成「CSS 补 grid-template-rows」后，行为契约不能变：
 * 收起时内容不挂 DOM（几百条会话的列不能替看不见的内容付挂载），打开时内容出现，
 * 收起动画期间内容还在但已 inert，动画走完再摘掉。
 *
 * 收起结束不靠真实计时器：全量 `bun test` 并发下 140ms 的 timer 会被拖到几十秒，单独跑却 1.3s 就过。
 * 这里注入一个手动调度口，断言在同一个同步步里完成，不把闸门的稳定性押在事件循环上。
 */

afterEach(cleanup)

function content(isOpen: boolean, schedule?: ExitScheduler) {
  return (
    <ThreadDisclosure {...(schedule === undefined ? {} : { schedule })} isOpen={isOpen}>
      <button type="button">会话一</button>
    </ThreadDisclosure>
  )
}

function mount(isOpen: boolean, schedule?: ExitScheduler) {
  return render(content(isOpen, schedule))
}

const neverCloses: ExitScheduler = () => () => undefined

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
    let close: (() => void) | undefined
    const schedule: ExitScheduler = (done) => {
      close = done
      return () => {
        close = undefined
      }
    }

    const view = mount(true, schedule)
    view.rerender(content(false, schedule))

    const shell = view.container.querySelector<HTMLElement>('.thread-disclosure')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-open')).toBe('false')
    expect(shell?.inert).toBe(true)
    expect(close).toBeDefined()

    act(() => {
      close?.()
    })
    expect(view.container.querySelector('.thread-disclosure')).toBeNull()
  })

  test('收起动画途中又打开：内容不先被摘掉，直接回到打开态', async () => {
    const view = mount(true, neverCloses)
    view.rerender(content(false, neverCloses))
    view.rerender(content(true, neverCloses))

    await waitFor(() => {
      expect(view.container.querySelector('.thread-disclosure')?.getAttribute('data-open')).toBe('true')
    })
    expect(view.container.textContent).toContain('会话一')
  })
})
