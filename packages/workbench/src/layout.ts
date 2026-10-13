/** 外壳的产品几何常量。`auxiliaryMaxWidth` 必须与宽度钳制读同一份常量，所以两者放在一起。 */
export const WORKSPACE_LAYOUT = {
  sidebar: {
    /** 导航图标中线距侧栏左边界；标题栏开合按钮与导航项图标靠这一个令牌对齐。 */
    navIconCenter: 24,
    minWidth: 220,
    maxWidth: 360,
    defaultWidth: 280,
  },
  /** 主列地板：两张卡片都在时正文至少这么宽，辅助列上限要把它让出来。 */
  main: { minWidth: 360 },
  /** 主区与辅助列是同一张卡片：四周留白、四角圆角、贴角控件的边长。 */
  card: { gap: 8, cornerRadius: 16, controlSize: 24 },
  auxiliary: { minWidth: 320, maxWidth: 800, defaultWidth: 420 },
  chrome: { height: 36 },
  /** 布局过渡的时间轴：秒与三次贝塞尔控制点，由 WorkspaceFrame 折成 CSS 值。 */
  motion: { layoutDurationSeconds: 0.22, layoutEase: [0.2, 0, 0, 1] as const },
} as const

export interface SidebarDock {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  /** 外壳此刻有多宽；缺省或 null 表示还没量到，那一维不设限。 */
  readonly viewportWidth?: number | null | undefined
}

/**
 * 辅助列宽度上限：产品上限与窗口剩余取更紧的一个。窗口剩余必须保住主列地板，否则三列之和超外壳宽、栅格溢出被裁；
 * 侧栏收起让出的宽度加回产品上限（面板能多读几列 diff）；下限优先 —— 窄到放不下下限时该让的是主列。
 */
export function auxiliaryMaxWidth(input: SidebarDock): number {
  const productCap = WORKSPACE_LAYOUT.auxiliary.maxWidth + (input.sidebarOpen ? 0 : input.sidebarWidth)
  const sidebarColumn = input.sidebarOpen ? input.sidebarWidth : 0
  const windowCap =
    input.viewportWidth === undefined || input.viewportWidth === null
      ? Number.POSITIVE_INFINITY
      : input.viewportWidth - sidebarColumn - WORKSPACE_LAYOUT.main.minWidth
  return Math.max(WORKSPACE_LAYOUT.auxiliary.minWidth, Math.min(productCap, windowCap))
}
