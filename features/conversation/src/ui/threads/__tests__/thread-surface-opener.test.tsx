import { afterEach, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { createThreadSurfaceOpener, useThreadSessionLifecycle } from '../thread-lifecycle'

/*
 * R-19-4：重启后由 navigation.restore 直接进到线程页时，没有人点侧栏，actions.openThread 不会跑。
 * 线程表面自己挂载（以及换对话）时就必须问一次控件表 —— 不然输入框下面那排选择器不画。
 */

afterEach(cleanup)

function harness() {
  const opened: string[] = []
  const refreshed: string[] = []
  const closed: string[] = []
  const open = createThreadSurfaceOpener({
    open: async (threadId) => {
      opened.push(threadId)
    },
    refreshControls: async (threadId) => {
      refreshed.push(threadId)
    },
  })
  const close = async (threadId: string): Promise<void> => {
    closed.push(threadId)
  }
  function Surface({ threadId }: { readonly threadId: string }) {
    useThreadSessionLifecycle({ threadId, open, close })
    return null
  }
  return { Surface, opened, refreshed, closed }
}

test('表面一挂载就预热并拉控件表（不依赖点侧栏）', () => {
  const h = harness()
  render(<h.Surface threadId="t-1" />)

  expect(h.opened).toEqual(['t-1'])
  expect(h.refreshed).toEqual(['t-1'])
})

test('同一个表面换对话：新对话同样拉一次控件表', () => {
  const h = harness()
  const view = render(<h.Surface threadId="t-1" />)
  view.rerender(<h.Surface threadId="t-2" />)

  expect(h.opened).toEqual(['t-1', 't-2'])
  expect(h.refreshed).toEqual(['t-1', 't-2'])
})

test('拉控件表失败不影响预热的结果', async () => {
  const open = createThreadSurfaceOpener({
    open: async () => 'warm',
    refreshControls: async () => {
      throw new Error('boom')
    },
  })

  expect(await open('t-1')).toBe('warm')
})
