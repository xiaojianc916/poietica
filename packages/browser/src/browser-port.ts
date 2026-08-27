/*
 * 浏览器宿主端口 —— 这个包对外的唯一依赖面。
 *
 * feature 包不认识传输层：端口在这里声明，实现由应用层用 IPC 绑定接上，
 * 与 settings 的 SettingsStore、plugins 的 palette 桥同一条纪律。
 * 状态是宿主广播的全量快照，这个包只投影，不另记一份标签账。
 */

export interface BrowserTabView {
  readonly id: number
  readonly url: string | null
  readonly title: string
  /** 内核此刻是否在装载这一页；标签条用它把地球换成转圈。 */
  readonly loading: boolean
  /** 站点图标的 data URL；缺席就是地球。 */
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

/** 面板视口在主窗口客户区里的逻辑坐标。 */
export interface BrowserViewportRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserHostPort {
  /** 先挂监听后拉快照，顺序由实现方保证。返回摘表函数。 */
  readonly watch: (onState: (state: BrowserHostView) => void) => Promise<() => void>
  readonly openTab: (url: string | null) => Promise<void>
  readonly closeTab: (id: number) => Promise<void>
  readonly selectTab: (id: number) => Promise<void>
  readonly navigate: (id: number, address: string) => Promise<void>
  readonly back: (id: number) => Promise<void>
  readonly forward: (id: number) => Promise<void>
  readonly reload: (id: number) => Promise<void>
  readonly setElementPicker: (id: number, enabled: boolean) => Promise<void>
  readonly reopenClosed: (index: number) => Promise<void>
  readonly setViewportBounds: (bounds: BrowserViewportRect) => Promise<void>
  readonly setVisible: (visible: boolean) => Promise<void>
  readonly openDevtools: (id: number) => Promise<void>
  readonly openExternal: (url: string) => Promise<void>
}
