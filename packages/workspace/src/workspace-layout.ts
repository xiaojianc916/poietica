/**
 * Poietica workspace product-layout contract.
 *
 * This module is the single source of truth for
 * Workspace shell dimensions. These values are
 * product semantics and do not belong to the
 * cross-feature design system.
 */
export const WORKSPACE_LAYOUT = {
  sidebar: {
    /*
     * 侧边栏导航图标的中线距侧边栏左边界的距离。
     *
     * 标题栏的侧边栏开合按钮和导航项图标分属两个包，靠这一个令牌对齐，
     * 而不是各自写一遍内边距——那样任何一侧调整都会静默错位。
     */
    navIconCenter: 24,

    minWidth: 220,
    maxWidth: 420,
    defaultWidth: 280,
  },

  /* 主列地板：两张卡片都在时正文至少留这么宽，辅助列上限要把它让出来。 */
  main: {
    minWidth: 320,
  },

  /*
   * 主区与辅助列是同一张卡片：四周留白、四角圆角、贴角那枚控件的边长。
   *
   * 三者各只有这一份，由 WorkspaceFrame 挂成 --workspace-card-* 挂到栅格根上：
   * 外壳、右栏标签条与浏览器视口（packages/workspace 自己）共读同一份。
   */
  card: {
    gap: 8,
    cornerRadius: 16,
    controlSize: 24,
  },

  /* 辅助列贴窗口 inline-end，一次只投影一个已登记面板。 */
  auxiliary: {
    minWidth: 320,
    maxWidth: 800,
    defaultWidth: 420,
  },

  /* 对话内任务浮层的卡片宽度与四周浮动间距。 */
  todo: {
    width: 320,
    gap: 12,
  },

  chrome: {
    height: 36,
  },
  /* 布局过渡的时间轴：秒与三次贝塞尔控制点，由 WorkspaceFrame 折成 CSS 值。 */
  motion: {
    layoutDurationSeconds: 0.22,
    layoutEase: [0.2, 0, 0, 1],
  },
} as const

/** 辅助列上限要看的两件事：侧边栏在不在占位，以及它占位时有多宽。 */
export interface SidebarDock {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  /**
   * 外壳此刻有多宽。缺省或 null 表示「还没量到」—— 那时窗口这一维不设限，只认产品
   * 规则。落盘与拖拽那一侧本来就不认识窗口，由渲染侧补上（见 WorkspaceShell）。
   */
  readonly viewportWidth?: number | null | undefined
}

/**
 * 辅助列的宽度上限：产品上限与窗口剩余取更紧的一个。
 *
 * - 产品上限（auxiliary.maxWidth）说的是面板自己能读多宽，与窗口无关。但侧边栏
 *   收起后让出的那一份宽度没人用 —— 主区拿到它只是把同一列正文摊得更开，面板
 *   拿到它能多读几列 diff。所以收起态多出侧边栏的宽度。
 * - 窗口剩下的：主列地板（main.minWidth）必须留得住。没有这一条，三列之和可以
 *   超过外壳宽 —— 栅格溢出被外壳裁掉，主区连同卡片右下两个圆角一起消失，而拖动
 *   到某个宽度之前一切正常。上限与主列怎么分配是两回事，但上限不能大于总量。
 *
 * 窗口窄到连辅助列自己的下限都放不下时，下限优先：主列是 minmax(0, 1fr)，它才是
 * 该让的那一个，而且上限不低过下限，分隔条的 aria-valuemax 才不可能小于 valuemin。
 */
export function auxiliaryMaxWidth(input: SidebarDock): number {
  const productCap =
    WORKSPACE_LAYOUT.auxiliary.maxWidth + (input.sidebarOpen ? 0 : input.sidebarWidth)
  const sidebarColumn = input.sidebarOpen ? input.sidebarWidth : 0
  const windowCap =
    input.viewportWidth === undefined || input.viewportWidth === null
      ? Number.POSITIVE_INFINITY
      : input.viewportWidth - sidebarColumn - WORKSPACE_LAYOUT.main.minWidth

  return Math.max(WORKSPACE_LAYOUT.auxiliary.minWidth, Math.min(productCap, windowCap))
}
