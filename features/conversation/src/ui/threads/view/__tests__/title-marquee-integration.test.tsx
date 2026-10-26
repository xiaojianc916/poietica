import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AssistantThreadList } from '../assistant-thread-list'

/*
 * 接线判据：横移的 ref 必须落在真正被裁的那一层、监听必须挂在整行上。
 * 只测 hook 的话，ref 指错节点或事件挂到按钮上都会照样绿。
 */

const LONG = 'A session title long enough that the sidebar has to clip it somewhere'
const FORKED = 'A forked conversation title wide enough to be clipped (2)'
const SHORT = '短标题'

afterEach(cleanup)

function mount(): HTMLElement {
  const view = render(
    <AssistantThreadList
      activeThreadId={null}
      archivedFilter="hide"
      collapsedWorkspaces={new Set()}
      groups={[
        {
          id: 'w1',
          name: null,
          items: [
            { id: 't1', title: LONG, updatedAt: '2026-10-20T00:00:00.000Z' },
            { id: 't2', title: FORKED, updatedAt: '2026-10-20T00:00:00.000Z' },
            { id: 't3', title: SHORT, updatedAt: '2026-10-20T00:00:00.000Z' },
          ],
        },
      ]}
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

/** 真正被裁的那一层：带分叉序号时是正文，否则是整枚标题。 */
function clipTarget(container: HTMLElement, title: string): HTMLElement {
  const titleElement = [...container.querySelectorAll('.assistant-thread__title')].find(
    (node) => node.textContent === title,
  )

  if (!(titleElement instanceof HTMLElement)) {
    throw new Error(`找不到标题元素：${title}`)
  }

  const base = titleElement.querySelector('.assistant-thread__title-base')

  return base instanceof HTMLElement ? base : titleElement
}

function rowOf(container: HTMLElement, title: string): HTMLElement {
  const row = clipTarget(container, title).closest('.assistant-thread')

  if (!(row instanceof HTMLElement)) {
    throw new Error('标题不在会话行里')
  }

  return row
}

/** jsdom 不算布局：把这一格的裁切几何直接报出来。 */
function clip(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true })
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 150)
  })

describe('会话列表：标题悬停横移的接线', () => {
  test('指针停在整行上，被裁的标题才爬；离开整行即复位', async () => {
    const view = mount()
    const title = clipTarget(view, LONG)

    clip(title, 320, 180)
    const row = rowOf(view, LONG)

    fireEvent.pointerEnter(row)
    await settle()

    expect(title.scrollLeft).toBeGreaterThan(0)
    expect(title.scrollLeft).toBeLessThan(140)

    fireEvent.pointerLeave(row)

    expect(title.scrollLeft).toBe(0)
  })

  test('放得下的标题一动不动', async () => {
    const view = mount()
    const title = clipTarget(view, SHORT)

    clip(title, 60, 60)

    fireEvent.pointerEnter(rowOf(view, SHORT))
    await settle()

    expect(title.scrollLeft).toBe(0)
  })

  test('带分叉序号的标题只移正文，序号钉在行尾不跟着跑', async () => {
    const view = mount()
    const base = clipTarget(view, FORKED)
    const ordinal = base.parentElement?.querySelector('.assistant-thread__title-ordinal')

    if (!(ordinal instanceof HTMLElement)) {
      throw new Error('找不到带序号的标题')
    }

    clip(base, 360, 200)

    fireEvent.pointerEnter(rowOf(view, FORKED))
    await settle()

    expect(base.scrollLeft).toBeGreaterThan(0)
    /* 序号不在 ref 那一层：它没有位移。 */
    expect(ordinal.scrollLeft).toBe(0)
  })
})
