/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type BrowserClosedTab = { url: string; title: string }
export type BrowserState = {
  revision: number
  tabs: BrowserTab[]
  activeTabId: number | null
  pickingTabId: number | null
  recentlyClosed: BrowserClosedTab[]
}
export type BrowserTab = {
  id: number
  url: string | null
  title: string
  loading: boolean
  /**
   * 站点图标的 data URL。缺席时渲染层画地球。
   */
  favicon: string | null
}
