/*
 * 内置浏览器的契约。标签模型归宿主（Electron 主进程的 WebContentsView），
 * 所以这几个类型在这里手写 —— 生成物里没有它们，原生侧也不再有 browser_* 命令。
 *
 * 字段与 apps/desktop/electron/browser/host.ts 产出的一字不差：线上形状只有一个产地，
 * 宿主改形状这里必须同步改。
 */

/** 一个标签。id 由宿主发放，同一进程内不重用。 */
export interface BrowserTab {
  readonly id: number
  /** 还没导航过时为 null（新开的空白标签）。 */
  readonly url: string | null
  readonly title: string
  readonly loading: boolean
  readonly favicon: string | null
}

/** 刚关掉、还能重新打开的标签。 */
export interface BrowserClosedTab {
  readonly url: string
  readonly title: string
}

/** 标签面的整份快照；revision 单调，订阅方据此丢掉迟到的旧帧。 */
export interface BrowserState {
  readonly revision: number
  readonly tabs: readonly BrowserTab[]
  readonly activeTabId: number | null
  readonly pickingTabId: number | null
  readonly recentlyClosed: readonly BrowserClosedTab[]
}

/** 元素拾取把报告落成一个文件，交给 agent 读一次；渲染层拿到的是这条指向它的路径。 */
export interface BrowserElementPicked {
  readonly reportPath: string
  readonly elementType: string
  readonly comment: string
  readonly submission: 'attach' | 'send' | 'cancel'
}

/** 外部页面把拾取结果交回来时的原始形状；reportPath 由宿主写文件后补上。 */
export interface BrowserPickSubmission {
  readonly token: number
  readonly elementType: string
  readonly comment: string
  readonly report: string
  readonly submission: 'attach' | 'send' | 'cancel'
}

/** 主题偏好在宿主那里落定后的那一档：跟随系统时就是系统此刻那一档。 */
export type ResolvedTheme = 'light' | 'dark'
