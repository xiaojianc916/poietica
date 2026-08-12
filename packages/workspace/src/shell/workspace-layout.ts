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

  /*
   * 布局断点以 CSS 媒体查询字符串表达，由 matchMedia 订阅：浏览器只在
   * 跨越断点时通知一次，不需要在每一帧 resize 上重新计算布局模式。
   */
  breakpoints: {
    compact: '(min-width: 900px)',
    wide: '(min-width: 1280px)',

    /*
     * 视口下限。主窗口在 tauri.conf.json 里定着 minWidth: 800 —— 用户拖不出
     * 更窄的窗口，低于此值的宽度必然不是视口：那是 Windows 最小化把窗口缩成
     * 图标尺寸（实测 144px）后，宿主当作真实 resize 透传进来的假几何。这样
     * 的采样不参与布局模式判定，由 use-workspace-layout 在提交前丢弃。
     */
    viewportFloor: 800,

    /*
     * 跨断点的布局切换等几何静止后才提交：resize 事件停歇这么久，视为这次
     * 拖拽缩放已经结束。取值需远大于拖拽中相邻 resize 事件的间隔（实测
     * 165Hz 下含丢帧最大约 24ms），又小到松手后感知不到迟滞。
     */
    settleMs: 180,
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
