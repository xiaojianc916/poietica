import type { BrowserState, BrowserTab } from './model'

/*
 * 宿主契约：本包需要原生宿主提供哪些动作。
 *
 * DTO 不在这里声明 —— 产地是 Rust，由 tauri-specta 生成进 @poietica/contract。
 * 这一层只把生成物摆成本包的词汇，消费者不必知道绑定住在哪个包里。
 */

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
