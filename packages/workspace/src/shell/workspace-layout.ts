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

  /* 浏览器列贴窗口 inline-end 一侧，与侧栏同一条动画时间轴。 */
  browser: {
    minWidth: 320,
    maxWidth: 800,
    defaultWidth: 420,
  },

  /* 侧栏能停靠的最小视口内宽，逻辑像素。判据在 shell/sidebar-docking.ts。 */
  breakpoints: {
    dockable: 900,
  },

  chrome: {
    height: 36,
  },
  /*
   * Runtime layout animation contract.
   *
   * Motion uses seconds and numeric cubic-bezier tuples,
   * so these values intentionally remain TypeScript
   * product tokens instead of CSS duration strings.
   */
  motion: {
    layoutDurationSeconds: 0.22,
    layoutEase: [0.2, 0, 0, 1],
  },
} as const

export type WorkspaceLayout = typeof WORKSPACE_LAYOUT
