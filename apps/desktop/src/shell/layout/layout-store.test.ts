import { expect, test } from 'bun:test'
import type { Preference } from '@poietica/external-store'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import {
  createWorkspaceLayoutStore,
  DEFAULT_LAYOUT_INTENT,
  type LayoutIntent,
} from './layout-store'

function fixture() {
  let value: LayoutIntent = { ...DEFAULT_LAYOUT_INTENT }
  const listeners = new Set<() => void>()
  const writes: LayoutIntent[] = []
  const external = (next: LayoutIntent): void => {
    value = next
    for (const listener of listeners) {
      listener()
    }
  }
  const preference: Preference<LayoutIntent> = {
    read: () => value,
    readFallback: () => DEFAULT_LAYOUT_INTENT,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    write: (next) => {
      writes.push(next)
      external(next)
    },
  }
  const store = createWorkspaceLayoutStore(preference)
  const stop = store.subscribe(() => undefined)
  return { store, stop, external, writes }
}

test('application instances and snapshots are isolated; no-op actions do not publish or persist', () => {
  const first = fixture()
  const second = fixture()
  const initial = first.store.getSnapshot()
  first.store.setSidebarOpen(initial.sidebarOpen)
  first.store.setSidebarWidth(initial.sidebarWidth)
  expect(first.store.getSnapshot()).toBe(initial)
  expect(first.writes).toHaveLength(0)
  first.store.toggleSidebar()
  expect(second.store.getSnapshot().sidebarOpen).toBe(DEFAULT_LAYOUT_INTENT.sidebarOpen)
  expect(first.store.getSnapshot()).not.toBe(initial)
  first.stop()
  second.stop()
})

test('only the dragging region may finish a drag and it flushes one persistent projection', () => {
  const { store, writes, stop } = fixture()
  const bounds = WORKSPACE_LAYOUT.sidebar
  const width =
    store.getSnapshot().sidebarWidth === bounds.minWidth ? bounds.maxWidth : bounds.minWidth
  store.setSplitterActivity('drag')
  store.setSidebarWidth(width)
  store.setTodoThread('thread-a')
  store.setAuxiliarySplitterActivity('idle')
  expect(store.getSnapshot().splitter).toBe('drag')
  expect(writes).toHaveLength(0)
  store.setSplitterActivity('idle')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.sidebarWidth).toBe(width)
  expect(Object.hasOwn(writes[0] ?? {}, 'todoThread')).toBe(false)
  expect(Object.hasOwn(writes[0] ?? {}, 'splitter')).toBe(false)
  stop()
})

test('external intent does not replace local interaction state', () => {
  const { store, external, writes, stop } = fixture()
  store.setTodoThread('thread-a')
  store.setSplitterActivity('drag')
  external({ ...DEFAULT_LAYOUT_INTENT, sidebarOpen: false })
  expect(store.getSnapshot()).toMatchObject({
    sidebarOpen: false,
    todoThread: 'thread-a',
    splitter: 'drag',
  })
  expect(writes).toHaveLength(0)
  store.setSplitterActivity('idle')
  stop()
})

test('background activity never steals another conversation and removal clears both owned regions', () => {
  const { store, stop } = fixture()
  expect(store.claimAuxiliaryThread('thread-a')).toBe(true)
  expect(store.claimAuxiliaryThread('thread-b')).toBe(false)
  expect(store.getSnapshot().auxiliaryThread).toBe('thread-a')
  store.setTodoThread('thread-a')
  store.forgetThread('thread-b')
  expect(store.getSnapshot().todoThread).toBe('thread-a')
  store.forgetThread('thread-a')
  expect(store.getSnapshot()).toMatchObject({ auxiliaryThread: null, todoThread: null })
  stop()
})

test('the auxiliary cap follows the sidebar dock, and a widened pane falls back when it returns', () => {
  const { store, stop } = fixture()
  const cap = WORKSPACE_LAYOUT.auxiliary.maxWidth
  const freed = store.getSnapshot().sidebarWidth
  store.setAuxiliaryWidth(cap + freed)
  expect(store.getSnapshot().auxiliaryWidth).toBe(cap)
  store.setSidebarOpen(false)
  store.setAuxiliaryWidth(cap + freed)
  expect(store.getSnapshot().auxiliaryWidth).toBe(cap + freed)
  store.setSidebarOpen(true)
  expect(store.getSnapshot().auxiliaryWidth).toBe(cap)
  stop()
})

test('the auxiliary cap follows the shell width, and never pushes the main column out', () => {
  const { store, stop } = fixture()
  const { auxiliary, main } = WORKSPACE_LAYOUT
  const sidebarWidth = store.getSnapshot().sidebarWidth
  const capAt = (viewportWidth: number): number => viewportWidth - sidebarWidth - main.minWidth

  store.setViewportWidth(1100)
  expect(store.getSnapshot().viewportWidth).toBe(1100)
  /* 拖到远超窗口宽：落进快照的是「窗口 − 侧栏 − 主列地板」。 */
  store.setAuxiliaryWidth(5000)
  expect(store.getSnapshot().auxiliaryWidth).toBe(capAt(1100))

  /* 窗口更窄，同一份宽度要跟着收。 */
  store.setViewportWidth(1000)
  expect(store.getSnapshot().auxiliaryWidth).toBe(capAt(1000))

  /* 窄到连下限都放不下时下限优先：不会出现低过 minWidth 的值。 */
  store.setViewportWidth(800)
  expect(capAt(800)).toBeLessThan(auxiliary.minWidth)
  expect(store.getSnapshot().auxiliaryWidth).toBe(auxiliary.minWidth)

  /* 窗口再宽回来它不会自己长回去：拖出来的宽度是用户的选择。 */
  store.setViewportWidth(1600)
  expect(store.getSnapshot().auxiliaryWidth).toBe(auxiliary.minWidth)
  stop()
})

test('an unmeasurable shell width is ignored rather than poisoning the cap', () => {
  const { store, stop } = fixture()
  const before = store.getSnapshot()
  store.setViewportWidth(Number.NaN)
  store.setViewportWidth(Number.POSITIVE_INFINITY)
  expect(store.getSnapshot()).toBe(before)
  expect(store.getSnapshot().viewportWidth).toBeNull()
  stop()
})

test('widths stay finite and disposal fences later mutation', () => {
  const { store, writes, stop } = fixture()
  expect(() => store.setSidebarWidth(Number.NaN)).toThrow(RangeError)
  expect(() => store.setAuxiliaryWidth(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  store.setSidebarWidth(-1000)
  expect(store.getSnapshot().sidebarWidth).toBe(WORKSPACE_LAYOUT.sidebar.minWidth)
  store.dispose()
  const settled = store.getSnapshot()
  const saved = writes.length
  store.toggleSidebar()
  expect(store.claimAuxiliaryThread('thread-a')).toBe(false)
  expect(store.getSnapshot()).toBe(settled)
  expect(writes).toHaveLength(saved)
  stop()
})

test('fullscreen is a transient state the shell can revoke, and it never reaches disk', () => {
  const { store, writes, stop } = fixture()
  store.toggleAuxiliaryFullscreen()
  expect(store.getSnapshot().auxiliaryFullscreen).toBe(true)
  /* 外壳判定这一格离场后写回 false：这是「收起即失效」真正成立的那一步。 */
  store.setAuxiliaryFullscreen(false)
  expect(store.getSnapshot().auxiliaryFullscreen).toBe(false)
  /* 全屏与窗口宽都不落盘：意图只有那四个字段。 */
  store.setViewportWidth(1200)
  for (const write of writes) {
    expect(Object.hasOwn(write, 'auxiliaryFullscreen')).toBe(false)
    expect(Object.hasOwn(write, 'viewportWidth')).toBe(false)
  }
  stop()
})
