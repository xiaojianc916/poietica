import type { BrowserState, BrowserTab } from '@poietica/contract/browser'

export type { BrowserState, BrowserTab }

/** 子 webview 在 dock 里该贴着哪块矩形：坐标与尺寸，单位 CSS 像素。 */
export interface BrowserViewportBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserHostPort {
  readonly watch: (onState: (state: BrowserState) => void) => Promise<() => void>
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
  readonly openExternally: (url: string) => Promise<void>
}
