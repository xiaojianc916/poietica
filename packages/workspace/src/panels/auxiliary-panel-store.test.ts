import { describe, expect, it } from 'bun:test'
import type { BrowserHostPort } from '@poietica/browser'
import { createAuxiliaryPanelStore } from './auxiliary-panel-store'

/* 这一格的内容与宿主无关：除最后一条，其余用例一个字节都不碰浏览器。 */
const silentPort: BrowserHostPort = {
  watch: () => Promise.resolve(() => undefined),
  openTab: () => Promise.resolve(),
  closeTab: () => Promise.resolve(),
  selectTab: () => Promise.resolve(),
  navigate: () => Promise.resolve(),
  back: () => Promise.resolve(),
  forward: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  print: () => Promise.resolve(),
  setElementPicker: () => Promise.resolve(),
  reopenClosed: () => Promise.resolve(),
  setViewportBounds: () => Promise.resolve(),
  setVisible: () => Promise.resolve(),
  openExternally: () => Promise.resolve(),
}

/* 宿主报来一页：用来问「这一格该不该看见它」。 */
const watchedPort: BrowserHostPort = {
  ...silentPort,
  watch: (onState) => {
    onState({
      revision: 1,
      tabs: [{ favicon: null, id: 1, loading: false, title: '示例', url: 'https://example.com' }],
      activeTabId: 1,
      pickingTabId: null,
      recentlyClosed: [],
    })

    return Promise.resolve(() => undefined)
  },
}

describe('auxiliary panel ownership', () => {
  it('keeps each owner to its own tabs', () => {
    const store = createAuxiliaryPanelStore(silentPort)

    store.setOwner('thread-a', true)
    store.openFile('thread-a', 'skill:review')
    expect(resources(store)).toEqual(['skill:review'])

    store.setOwner('settings', false)
    expect(resources(store)).toEqual([])

    store.openFile('settings', 'skill:ponytail')
    expect(resources(store)).toEqual(['skill:ponytail'])

    store.setOwner('thread-a', true)
    expect(resources(store)).toEqual(['skill:review'])
  })

  it('records a tab opened for another owner without projecting it', () => {
    const store = createAuxiliaryPanelStore(silentPort)

    store.setOwner('thread-a', true)
    store.openFile('settings', 'skill:review')
    expect(store.getSnapshot().panes).toEqual([])

    store.setOwner('settings', false)
    expect(store.getSnapshot().focus).toEqual({ kind: 'pane', id: 'file:skill:review' })
  })

  it('drops the projection when nobody owns the panel', () => {
    const store = createAuxiliaryPanelStore(silentPort)

    store.setOwner('thread-a', true)
    store.openFile('thread-a', 'skill:review')

    store.setOwner(null, true)
    expect(store.getSnapshot().panes).toEqual([])
    expect(store.getSnapshot().focus).toEqual({ kind: 'browser' })
  })

  it('leaves the host out of a panel that does not claim the browser', () => {
    const store = createAuxiliaryPanelStore(watchedPort)

    store.start()

    store.setOwner('thread-a', true)
    expect(store.getSnapshot().host?.tabs).toHaveLength(1)

    store.setOwner('settings', false)
    expect(store.getSnapshot().host).toBeNull()
  })
})

function resources(store: ReturnType<typeof createAuxiliaryPanelStore>): readonly string[] {
  return store.getSnapshot().panes.map((pane) => pane.resourceId ?? pane.id)
}
