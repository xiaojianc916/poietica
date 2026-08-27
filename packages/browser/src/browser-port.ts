import type {
  BrowserPopupAction,
  BrowserPopupRequest,
  BrowserState,
  BrowserTab,
  BrowserViewportBounds,
} from '@poietica/ipc'

/*
 * 宿主契约：本包需要原生宿主提供哪些动作。
 *
 * DTO 不在这里声明 —— 产地是 Rust，由 tauri-specta 生成进 @poietica/ipc。
 * 这一层只把生成物摆成本包的词汇，消费者不必知道绑定住在哪个包里。
 */

export type {
  BrowserPopupAction,
  BrowserPopupRequest,
  BrowserState,
  BrowserTab,
  BrowserViewportBounds,
}

/** 浮层的脸。 */
export type BrowserPopupKind = BrowserPopupRequest['kind']

/** 浮层里列出的一格通道。 */
export type BrowserPopupPaneView = BrowserPopupRequest['panes'][number]

export interface BrowserHostPort {
  readonly watch: (onState: (state: BrowserState) => void) => Promise<() => void>
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
  readonly setViewportBounds: (bounds: BrowserViewportBounds) => Promise<void>
  readonly setVisible: (visible: boolean) => Promise<void>
  readonly openPopup: (request: BrowserPopupRequest, rect: BrowserViewportBounds) => Promise<void>
  readonly dispatchPopupAction: (action: BrowserPopupAction) => Promise<void>
  readonly closePopup: () => Promise<void>
}
