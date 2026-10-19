/**
 * 外壳的产品几何常量（视觉部分）。三列的宽度边界不在这里：它们与钳制、几何解算同住 ui-kernel 的
 * `LAYOUT_LIMITS` / `resolveLayoutGeometry`，外壳只读解算结果 —— 两份边界各钳各的正是「一拖就跳」的来源。
 */
export const WORKSPACE_LAYOUT = {
  sidebar: {
    /** 导航图标中线距侧栏左边界；标题栏开合按钮与导航项图标靠这一个令牌对齐。 */
    navIconCenter: 24,
  },
  /** 主区与辅助列是同一张卡片：四周留白、四角圆角、贴角控件的边长。 */
  card: { gap: 8, cornerRadius: 16, controlSize: 24 },
  chrome: { height: 36 },
  /** 布局过渡的时间轴：秒与三次贝塞尔控制点，由 WorkspaceFrame 折成 CSS 值。 */
  motion: { layoutDurationSeconds: 0.22, layoutEase: [0.2, 0, 0, 1] as const },
} as const
