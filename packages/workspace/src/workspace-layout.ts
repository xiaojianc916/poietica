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

  main: {
    /* DeepSeek Harness 的内容列下限；低于它时辅助面板覆盖而不再挤压正文。 */
    minWidth: 640,
  },

  /* 辅助列贴窗口 inline-end，一次只投影一个已登记面板。 */
  auxiliary: {
    minWidth: 320,
    maxWidth: 800,
    defaultWidth: 420,
  },

  /* 独立任务弹窗的卡片宽度与四周浮动间距。 */
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

export type PanelMode = 'dock' | 'overlay'

/**
 * 一枚贴边面板是挤压还是覆盖。
 *
 * availableWidth 是它所在那一行的可用宽度：面板占的那一段算在里面，所以判据与
 * 面板此刻开着还是关着无关，不存在开合互相触发的回路。两侧面板共用这一条。
 */
export function resolvePanelMode(availableWidth: number, panelWidth: number): PanelMode {
  return availableWidth - panelWidth >= WORKSPACE_LAYOUT.main.minWidth ? 'dock' : 'overlay'
}
