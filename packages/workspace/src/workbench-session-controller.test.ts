import { describe, expect, it } from 'bun:test'

import { createWorkbenchSessionController } from './workbench-session-controller'

describe('workbench session controller', () => {
  it('starts on the AI surface', () => {
    const store = createWorkbenchSessionController()

    expect(store.getSnapshot()).toMatchObject({
      activeTabId: 'surface:ai',
      activeSurface: {
        kind: 'surface',
        tabId: 'surface:ai',
        surfaceId: 'ai',
        title: '新建对话',
      },
      tabs: [
        {
          id: 'surface:ai',
          kind: 'surface',
          surfaceId: 'ai',
          title: '新建对话',
          canClose: true,
          isActive: true,
        },
      ],
    })
  })

  it('opens new tabs immediately right of active tab', () => {
    const store = createWorkbenchSessionController()

    store.openConversationInNewTab({
      threadId: 'thread-1',
      title: 'One',
    })

    store.activateTab('surface:ai')

    store.openSurface({ surfaceId: 'tools' })

    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
      'surface:ai',
      'surface:tools',
      'conversation:thread-1',
    ])
  })

  it('deduplicates singleton surfaces', () => {
    const store = createWorkbenchSessionController()

    store.openSurface({ surfaceId: 'search' })

    store.openSurface({ surfaceId: 'search' })

    expect(store.getSnapshot().tabs.filter((tab) => tab.id === 'surface:search')).toHaveLength(1)
  })

  it('selects the right adjacent tab after closing active', () => {
    const store = createWorkbenchSessionController()

    store.openSurface({ surfaceId: 'tools' })

    store.openSurface({ surfaceId: 'search' })

    store.activateTab('surface:tools')
    store.closeTab('surface:tools')

    expect(store.getSnapshot().activeTabId).toBe('surface:search')
  })

  it('selects the left adjacent tab when closing the last tab', () => {
    const store = createWorkbenchSessionController()

    store.openSurface({ surfaceId: 'tools' })

    store.closeTab('surface:tools')

    expect(store.getSnapshot().activeTabId).toBe('surface:ai')
  })

  it('moves tabs including the default surface tab', () => {
    const store = createWorkbenchSessionController()

    store.openSurface({ surfaceId: 'tools' })

    store.openSurface({ surfaceId: 'search' })

    store.moveTab('surface:search', 1)

    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
      'surface:ai',
      'surface:search',
      'surface:tools',
    ])

    store.moveTab('surface:ai', 2)

    expect(store.getSnapshot().tabs[2]?.id).toBe('surface:ai')
  })

  it('drops the tab of a deleted conversation and lands on a neighbour', () => {
    const store = createWorkbenchSessionController()

    store.openConversationInNewTab({ threadId: 'thread-1', title: 'One' })
    store.openConversationInNewTab({ threadId: 'thread-2', title: 'Two' })
    store.activateTab('conversation:thread-1')

    store.closeConversation('thread-1')

    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
      'surface:ai',
      'conversation:thread-2',
    ])
    expect(store.getSnapshot().activeTabId).toBe('conversation:thread-2')
  })

  it('falls back to the conversation entry when the last tab is deleted', () => {
    const store = createWorkbenchSessionController()

    store.openConversation({ threadId: 'thread-1', title: 'One' })

    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['conversation:thread-1'])

    store.closeConversation('thread-1')

    expect(store.getSnapshot()).toMatchObject({
      activeTabId: 'surface:ai',
      activeSurface: { kind: 'surface', surfaceId: 'ai' },
    })
  })
})
