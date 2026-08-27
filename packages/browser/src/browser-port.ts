export interface BrowserTabView {
  readonly id: number
  readonly url: string | null
  readonly title: string
  readonly loading: boolean
  readonly favicon: string | null
}

export interface BrowserClosedTabView {
  readonly url: string
  readonly title: string
}

export interface BrowserHostView {
  readonly tabs: readonly BrowserTabView[]
  readonly activeTabId: number | null
  readonly pickingTabId: number | null
  readonly recentlyClosed: readonly BrowserClosedTabView[]
}

export type BrowserPopupKind = 'overflow' | 'tabs'

export interface BrowserPopupPaneView {
  readonly id: string
  readonly title: string
}

export interface BrowserPopupRequest {
  readonly kind: BrowserPopupKind
  readonly theme: string
  readonly panes: readonly BrowserPopupPaneView[]
  readonly activePaneId: string | null
}

export interface BrowserPopupAction {
  readonly action: 'select-pane' | 'close-pane' | 'select-tab' | 'close-tab' | 'reopen-closed'
  readonly paneId: string | null
  readonly tabId: number | null
  readonly index: number | null
}

export interface BrowserViewportRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserHostPort {
  readonly watch: (onState: (state: BrowserHostView) => void) => Promise<() => void>
  readonly watchPopupActions: (
    onAction: (action: BrowserPopupAction) => void,
  ) => Promise<() => void>
  readonly openTab: (url: string | null) => Promise<void>
  readonly closeTab: (id: number) => Promise<void>
  readonly selectTab: (id: number) => Promise<void>
  readonly navigate: (id: number, address: string) => Promise<void>
  readonly back: (id: number) => Promise<void>
  readonly forward: (id: number) => Promise<void>
  readonly reload: (id: number) => Promise<void>
  readonly print: (id: number) => Promise<void>
  readonly setElementPicker: (id: number, enabled: boolean) => Promise<void>
  readonly reopenClosed: (index: number) => Promise<void>
  readonly setViewportBounds: (bounds: BrowserViewportRect) => Promise<void>
  readonly setVisible: (visible: boolean) => Promise<void>
  readonly openDevtools: (id: number) => Promise<void>
  readonly openExternal: (url: string) => Promise<void>
  readonly openPopup: (request: BrowserPopupRequest, rect: BrowserViewportRect) => Promise<void>
  readonly dispatchPopupAction: (action: BrowserPopupAction) => Promise<void>
  readonly closePopup: () => Promise<void>
}
