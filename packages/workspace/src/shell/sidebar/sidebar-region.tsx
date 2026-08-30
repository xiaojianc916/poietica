import { RegionSplitter } from '@poietica/design-system'
import type { ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from '../workspace-layout'
import { workspaceLayoutStore } from '../workspace-layout-store'

export interface SidebarRegionProps {
  readonly isDocked: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

/**
 * 侧边栏区域。
 *
 * 可见性是用户意图，唯一所有者是 workspace-layout-store。
 *
 * 收起只有一种形态：列宽归零，定宽底面被自己那一列裁掉，子树不卸载也不位移。
 *
 * 收起态的不可交互由 inert 承担：overflow 裁剪不拦键盘焦点，aria-hidden 不移出
 * Tab 序且挂着可聚焦内容违反 ARIA 要求。
 */
export function SidebarRegion({
  isDocked,
  width,
  onClose,
  onResize,
  children,
}: SidebarRegionProps) {
  return (
    <div
      className="workspace-shell__sidebar min-h-0 min-w-0 overflow-visible bg-sidebar"
      inert={!isDocked}
    >
      <div className="workspace-shell__region-clip">
        <div
          className="workspace-shell__sidebar-content h-full min-h-0 overflow-hidden"
          style={{ width }}
        >
          {children}
        </div>
      </div>

      {isDocked ? (
        <RegionSplitter
          edge="inline-start"
          label="调整侧边栏宽度"
          max={WORKSPACE_LAYOUT.sidebar.maxWidth}
          min={WORKSPACE_LAYOUT.sidebar.minWidth}
          onActivity={workspaceLayoutStore.setSplitterActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
