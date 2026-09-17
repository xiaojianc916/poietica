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
}

/**
 * 辅助列的宽度上限。
 *
 * 产品上限（auxiliary.maxWidth）说的是面板自己能读多宽，与窗口无关。但侧边栏
 * 收起后让出的那一份宽度没人用 —— 主区拿到它只是把同一列正文摊得更开，面板
 * 拿到它能多读几列 diff。所以上限随停靠状态走：展开时是产品上限，收起时多出
 * 侧边栏的宽度。展开态因此保持原样，只有收起态多出这一份。
 *
 * 这里只给上限，实际宽度仍由用户拖出来 —— 上限与主区怎么分配是两回事。
 */
export function auxiliaryMaxWidth(sidebar: SidebarDock): number {
  return WORKSPACE_LAYOUT.auxiliary.maxWidth + (sidebar.sidebarOpen ? 0 : sidebar.sidebarWidth)
}
