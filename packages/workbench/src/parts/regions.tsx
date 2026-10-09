import { RegionSplitter } from '@poietica/design-system'
import type { ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from '../layout'

export interface SidebarRegionProps {
  readonly isDocked: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly onActivity: (activity: 'idle' | 'hover' | 'drag') => void
  readonly children: ReactNode
}

/** **迁移自** legacy `shell/layout/sidebar-region.tsx`：结构、类名、inert 一字未改。 */
export function SidebarRegion({
  isDocked,
  width,
  onClose,
  onResize,
  onActivity,
  children,
}: SidebarRegionProps): ReactNode {
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
          onActivity={onActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}

export interface AuxiliaryRegionProps {
  readonly isDocked: boolean
  readonly fullscreen: boolean
  readonly width: number
  readonly maxWidth: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly onActivity: (activity: 'idle' | 'hover' | 'drag') => void
  readonly children: ReactNode
}

/** **迁移自** legacy `shell/layout/auxiliary-region.tsx`。 */
export function AuxiliaryRegion({
  isDocked,
  fullscreen,
  width,
  maxWidth,
  onClose,
  onResize,
  onActivity,
  children,
}: AuxiliaryRegionProps): ReactNode {
  return (
    <div className="workspace-shell__region workspace-shell__auxiliary bg-chrome" inert={!isDocked}>
      <div className="workspace-shell__region-clip">
        <div
          className="workspace-shell__region-content workspace-shell__auxiliary-content bg-background"
          style={{ width: fullscreen ? '100%' : width - WORKSPACE_LAYOUT.card.gap }}
        >
          {children}
        </div>
      </div>

      {isDocked && !fullscreen ? (
        <RegionSplitter
          edge="inline-end"
          label="调整辅助面板宽度"
          max={maxWidth}
          min={WORKSPACE_LAYOUT.auxiliary.minWidth}
          onActivity={onActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
