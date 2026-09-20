import { RegionSplitter } from '@poietica/design-system'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { useWorkspaceLayoutStore } from './layout-context'

export interface SidebarRegionProps {
  readonly isDocked: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

export function SidebarRegion({
  isDocked,
  width,
  onClose,
  onResize,
  children,
}: SidebarRegionProps) {
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  return (
    <div className="workspace-shell__region workspace-shell__sidebar bg-sidebar" inert={!isDocked}>
      <div className="workspace-shell__region-clip">
        {/* 定宽内容贴 inline-start：列窄于内容时从右边（远离主区那一端）被裁掉。 */}
        <div className="workspace-shell__region-content" style={{ width }}>
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
