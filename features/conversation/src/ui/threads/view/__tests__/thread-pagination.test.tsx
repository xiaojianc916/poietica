import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AssistantThreadList } from '../assistant-thread-list'

afterEach(cleanup)

function mount(count: number): HTMLElement {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `t${index + 1}`,
    title: `会话 ${index + 1}`,
    updatedAt: '2026-10-20T00:00:00.000Z',
  }))

  const view = render(
    <AssistantThreadList
      activeThreadId={null}
      archivedFilter="hide"
      collapsedWorkspaces={new Set()}
      groups={[{ id: 'w1', name: null, items }]}
      onActivate={() => undefined}
      onAddWorkspace={() => undefined}
      onArchivedFilterChange={() => undefined}
      onArchive={() => undefined}
      onCreate={() => undefined}
      onPin={() => undefined}
      onToggleWorkspace={() => undefined}
      runningThreadIds={new Set()}
    />,
  )

  return view.container
}

function renderedRows(container: HTMLElement): number {
  return container.querySelectorAll('.assistant-threads__list .assistant-thread').length
}

function moreButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('.assistant-threads__more')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('找不到「展开其余」按钮')
  }
  return button
}

describe('会话列表：分页展开', () => {
  test('默认十条，每次多五条，展开到底后可以收起回十条', () => {
    const view = mount(17)

    expect(renderedRows(view)).toBe(10)
    expect(moreButton(view).textContent).toBe('展开其余 7 个会话')

    fireEvent.click(moreButton(view))
    expect(renderedRows(view)).toBe(15)
    expect(moreButton(view).textContent).toBe('展开其余 2 个会话')

    fireEvent.click(moreButton(view))
    expect(renderedRows(view)).toBe(17)
    expect(moreButton(view).textContent).toBe('收起全部')

    fireEvent.click(moreButton(view))
    expect(renderedRows(view)).toBe(10)
    expect(moreButton(view).textContent).toBe('展开其余 7 个会话')
  })

  test('不足默认条数时不出现展开按钮', () => {
    const view = mount(10)

    expect(renderedRows(view)).toBe(10)
    expect(view.querySelector('.assistant-threads__more')).toBeNull()
  })
})
