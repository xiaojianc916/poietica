import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { leaveForArchive, useThreadSessionLifecycle } from '../thread-lifecycle'

/*
 * 性能方案 P4：看不开、写才开。表面挂载（以及换对话）只问控件表 —— R-19-4：重启后由 navigation.restore 直接进到线程页时
 * 没有人点侧栏，表面自己不问，输入框下面那排选择器就不画；会话等人开始写（engage）才预热，每条对话每次挂载只发一次。
 */

afterEach(cleanup)

function harness(options: { readonly failRefresh?: boolean } = {}) {
  const opened: string[] = []
  const refreshed: string[] = []
  const closed: string[] = []
  const open = async (threadId: string): Promise<void> => {
    opened.push(threadId)
  }
  const close = async (threadId: string): Promise<void> => {
    closed.push(threadId)
  }
  const refreshControls = async (threadId: string): Promise<void> => {
    refreshed.push(threadId)
    if (options.failRefresh === true) throw new Error('boom')
  }
  let engage: () => void = () => undefined
  function Surface({ threadId }: { readonly threadId: string }) {
    engage = useThreadSessionLifecycle({ threadId, open, close, refreshControls })
    return null
  }
  return { Surface, opened, refreshed, closed, engage: () => engage() }
}

test('表面一挂载就拉控件表，但不开会话（只是看）', () => {
  const h = harness()
  render(<h.Surface threadId="t-1" />)

  expect(h.refreshed).toEqual(['t-1'])
  expect(h.opened).toEqual([])
})

test('人开始写才预热：同一条对话、同一次挂载只发一次', () => {
  const h = harness()
  render(<h.Surface threadId="t-1" />)
  h.engage()
  h.engage()

  expect(h.opened).toEqual(['t-1'])
})

test('同一个表面换对话：新对话拉一次控件表；预热要等在新对话里开始写', () => {
  const h = harness()
  const view = render(<h.Surface threadId="t-1" />)
  h.engage()
  view.rerender(<h.Surface threadId="t-2" />)

  expect(h.refreshed).toEqual(['t-1', 't-2'])
  expect(h.opened).toEqual(['t-1'])
  h.engage()
  expect(h.opened).toEqual(['t-1', 't-2'])
})

test('切走（上一条已释放）再切回来：再开始写会重新预热', async () => {
  const h = harness()
  const view = render(<h.Surface threadId="t-1" />)
  h.engage()
  view.rerender(<h.Surface threadId="t-2" />)
  await Bun.sleep(5)
  expect(h.closed).toEqual(['t-1'])
  view.rerender(<h.Surface threadId="t-1" />)
  h.engage()

  expect(h.opened).toEqual(['t-1', 't-1'])
})

test('拉控件表失败不影响预热', () => {
  const h = harness({ failRefresh: true })
  render(<h.Surface threadId="t-1" />)
  h.engage()

  expect(h.opened).toEqual(['t-1'])
})

test('卸载发 threads.close；StrictMode 的双挂载不发', async () => {
  const strict = harness()
  const view = render(
    <StrictMode>
      <strict.Surface threadId="t-1" />
    </StrictMode>,
  )
  await Bun.sleep(5)
  expect(strict.closed).toEqual([])
  expect(strict.opened).toEqual([])
  view.unmount()
  await Bun.sleep(5)
  expect(strict.closed).toEqual(['t-1'])
})

/*
 * 归档当前会话要让位（用户 2026-10-19）：停在一个已归档的会话里，侧栏已经没有它那一行、
 * 主区却还开着它。归档别的对话时页面不动 —— 只是列表里少一行。
 */
describe('归档时当前页面要不要让位', () => {
  test('归档的正是当前这条 → 回入口页', () => {
    expect(leaveForArchive('t-1', 't-1')).toBe(true)
  })

  test('归档的是别的对话 → 页面不动', () => {
    expect(leaveForArchive('t-1', 't-2')).toBe(false)
  })

  test('没停在对话上（入口页 / 设置页）→ 不跳，归档照常完成', () => {
    expect(leaveForArchive(null, 't-1')).toBe(false)
  })
})
