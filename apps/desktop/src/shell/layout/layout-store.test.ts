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
