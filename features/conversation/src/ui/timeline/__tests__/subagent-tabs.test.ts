import { describe, expect, test } from 'bun:test'
import type { LayoutService } from '@poietica/ui-kernel'
import { SubagentTabsStore } from '../subagent-tabs'
import { createSubagentDockTabs, openSubagentTab, SUBAGENT_PANEL_ID } from '../view/subagent-dock'

/*
 * 布局服务的最小替身：只做这几条用例碰得到的部分，派生规则照内核（在场 = 有归属且归属正是前台；选中格 = 归属那一份的 activeId）。
 * 内核不导出工厂，功能不能深引它的实现。
 */
function fakeLayout(): LayoutService & { setPanelSize(location: 'right', px: number): void } {
  let owner: string | null = null
  let activeOwner: string | null = null
  let size = 420
  let byOwner: Record<string, { ids: readonly string[]; activeId: string | null }> = {}
  const listeners = new Set<() => void>()
  const fire = () => {
    for (const listener of [...listeners]) listener()
  }
  const state = () => {
    const open = owner !== null && owner === activeOwner
    return {
      sidebar: { visible: true, width: 280 },
      right: { open, activeId: open && owner !== null ? (byOwner[owner]?.activeId ?? null) : null, size },
      auxiliary: { owner, activeOwner, fullscreen: false },
    }
  }
  const fake = {
    current: state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    panes: { current: () => ({ byOwner }), subscribe: () => () => undefined },
    setActiveOwner: (next: string | null) => {
      activeOwner = next
      fire()
    },
    setAuxiliaryOwner: (next: string | null) => {
      owner = next
      fire()
    },
    openPane: (target: string, paneId: string) => {
      const ids = byOwner[target]?.ids ?? []
      byOwner = { ...byOwner, [target]: { ids: ids.includes(paneId) ? ids : [...ids, paneId], activeId: paneId } }
      owner = target
      fire()
    },
    focusPane: (target: string, paneId: string) => {
      byOwner = { ...byOwner, [target]: { ids: byOwner[target]?.ids ?? [], activeId: paneId } }
      fire()
    },
    setPanelSize: (_location: 'right', px: number) => {
      size = px
      fire()
    },
  }
  return fake as unknown as LayoutService & { setPanelSize(location: 'right', px: number): void }
}

describe('SubagentTabsStore', () => {
  test('打开去重并选中；关掉选中的那个落到剩下的最后一个', () => {
    const store = new SubagentTabsStore()
    store.open('t1', 'a', '查资料')
    store.open('t1', 'b')
    store.open('t1', 'a')

    expect(store.of('t1')).toEqual({ ids: ['a', 'b'], activeId: 'a' })
    expect(store.titleOf('t1', 'a')).toBe('查资料')
    expect(store.close('t1', 'a')).toBe(1)
    expect(store.of('t1')).toEqual({ ids: ['b'], activeId: 'b' })
    expect(store.close('t1', 'b')).toBe(0)
    expect(store.of('t1')).toBeNull()
  })

  test('按对话分账；forget 清掉整条对话', () => {
    const store = new SubagentTabsStore()
    store.open('t1', 'a')
    store.open('t2', 'b')
    store.forget('t1')

    expect(store.of('t1')).toBeNull()
    expect(store.of('t2')?.ids).toEqual(['b'])
  })

  test('快照引用只随变更换', () => {
    const store = new SubagentTabsStore()
    store.open('t1', 'a')
    const first = store.of('t1')
    store.open('t1', 'a')
    store.select('t1', 'a')

    expect(store.of('t1')).toBe(first)
  })
})

describe('右坞的子代理组', () => {
  test('打开即认领坞并选中子代理组；标签只报坞归属那条对话的', () => {
    const layout = fakeLayout()
    const store = new SubagentTabsStore()
    const tabs = createSubagentDockTabs({ layout, store, resolveTitle: (_thread, agentId) => `名字 ${agentId}` })
    layout.setActiveOwner('t1')
    openSubagentTab(layout, store, 't1', 'a', '查资料')
    store.open('t2', 'z')

    expect(layout.current().right.open).toBe(true)
    expect(layout.current().right.activeId).toBe(SUBAGENT_PANEL_ID)
    expect(tabs.tabs().map((tab) => [tab.id, tab.title, tab.active])).toEqual([['a', '查资料', true]])

    openSubagentTab(layout, store, 't1', 'b')
    expect(tabs.tabs().map((tab) => [tab.title, tab.active])).toEqual([
      ['查资料', false],
      ['名字 b', true],
    ])
  })

  test('最后一个标签关掉时把坞的选中挪回别的格', () => {
    const layout = fakeLayout()
    const store = new SubagentTabsStore()
    const tabs = createSubagentDockTabs({ layout, store, resolveTitle: (_thread, agentId) => agentId })
    layout.setActiveOwner('t1')
    layout.openPane('t1', 'conversation.auxiliary')
    openSubagentTab(layout, store, 't1', 'a')
    tabs.onClose('a')

    expect(tabs.tabs()).toEqual([])
    expect(layout.current().right.activeId).toBe('conversation.auxiliary')
  })

  test('订阅：标签变化与坞换归属才通知，拖宽不通知', () => {
    const layout = fakeLayout()
    const store = new SubagentTabsStore()
    const tabs = createSubagentDockTabs({ layout, store, resolveTitle: (_thread, agentId) => agentId })
    let calls = 0
    const off = tabs.subscribe(() => {
      calls += 1
    })
    layout.setActiveOwner('t1')
    openSubagentTab(layout, store, 't1', 'a')
    const afterOpen = calls
    layout.setPanelSize('right', 500)

    expect(afterOpen).toBeGreaterThan(0)
    expect(calls).toBe(afterOpen)
    off()
  })
})
