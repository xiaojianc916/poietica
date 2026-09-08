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

    store.openSurface({ surfaceId: 'library' })

    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
      'surface:ai',
      'surface:library',
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

    store.openSurface({ surfaceId: 'library' })

    store.openSurface({ surfaceId: 'search' })

    store.activateTab('surface:library')
    store.closeTab('surface:library')

    expect(store.getSnapshot().activeTabId).toBe('surface:search')
  })

  it('selects the left adjacent tab when closing the last tab', () => {
    const store = createWorkbenchSessionController()

    store.openSurface({ surfaceId: 'library' })

    store.closeTab('surface:library')

    expect(store.getSnapshot().activeTabId).toBe('surface:ai')
  })

  it('moves tabs including the default surface tab', () => {
    const store = createWorkbenchSessionController()

    store.openSurface({ surfaceId: 'library' })

    store.openSurface({ surfaceId: 'search' })

    store.moveTab('surface:search', 1)

    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
      'surface:ai',
      'surface:search',
      'surface:library',
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

  it('restores the library as a singleton surface', () => {
    const store = createWorkbenchSessionController({
      restored: JSON.stringify({
        entries: [{ kind: 'surface', surfaceId: 'library' }],
        activeIndex: 0,
      }),
    })
    store.openSurface({ surfaceId: 'library' })
    expect(store.getSnapshot().tabs).toHaveLength(1)
    expect(store.getSnapshot().activeSurface).toMatchObject({
      surfaceId: 'library',
      title: '资料库',
    })
  })

  it.each([0, 1, 2])(
    'preserves conversations around a removed surface at index %s',
    (activeIndex) => {
      const store = createWorkbenchSessionController({
        restored: JSON.stringify({
          entries: [
            { kind: 'conversation', threadId: 'first', title: 'First' },
            { kind: 'surface', surfaceId: 'unregistered-surface' },
            { kind: 'conversation', threadId: 'second', title: 'Second' },
          ],
          activeIndex,
        }),
      })
      expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
        'conversation:first',
        'conversation:second',
      ])
      expect(store.getSnapshot().activeTabId).toBe(
        activeIndex === 0 ? 'conversation:first' : 'conversation:second',
      )
    },
  )

  it('returns to the entry when no registered surface remains', () => {
    const store = createWorkbenchSessionController({
      restored: JSON.stringify({
        entries: [{ kind: 'surface', surfaceId: 'unregistered-surface' }],
        activeIndex: 0,
      }),
    })
    expect(store.getSnapshot().activeTabId).toBe('surface:ai')
  })

  it('still rejects malformed persisted entries', () => {
    const store = createWorkbenchSessionController({
      restored: JSON.stringify({
        entries: [{ kind: 'surface', surfaceId: 42 }],
        activeIndex: 0,
      }),
    })
    expect(store.getSnapshot().activeTabId).toBe('surface:ai')
  })
})
