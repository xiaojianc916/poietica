import { RegionSplitter } from '@poietica/design-system'
import type { RegionGeometry } from '@poietica/ui-kernel'
import type { ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from '../layout'

export interface SidebarRegionProps {
  readonly isDocked: boolean
  /** 有效几何（LayoutService.geometry）：内容宽、分隔条范围与当前值都从这一份读，不读意图宽度。 */
  readonly geometry: RegionGeometry
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly onActivity: (activity: 'idle' | 'hover' | 'drag') => void
  readonly children: ReactNode
}

export function SidebarRegion({
  isDocked,
  geometry,
  onClose,
  onResize,
  onActivity,
  children,
}: SidebarRegionProps): ReactNode {
  return (
    <div className="workspace-shell__region workspace-shell__sidebar bg-sidebar" inert={!isDocked}>
      <div className="workspace-shell__region-clip">
        {/* 定宽内容贴 inline-start：列窄于内容时从右边（远离主区那一端）被裁掉。 */}
        <div className="workspace-shell__region-content" style={{ width: geometry.size }}>
          {children}
        </div>
      </div>

      {isDocked ? (
        <RegionSplitter
          edge="inline-start"
          label="调整侧边栏宽度"
          max={geometry.max}
          min={geometry.min}
          onActivity={onActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={geometry.size}
        />
      ) : null}
    </div>
  )
}

export interface AuxiliaryRegionProps {
  readonly isDocked: boolean
  readonly fullscreen: boolean
  /** 同 SidebarRegionProps.geometry。 */
  readonly geometry: RegionGeometry
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly onActivity: (activity: 'idle' | 'hover' | 'drag') => void
  readonly children: ReactNode
}

export function AuxiliaryRegion({
  isDocked,
  fullscreen,
  geometry,
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
          style={{ width: fullscreen ? '100%' : geometry.size - WORKSPACE_LAYOUT.card.gap }}
        >
          {children}
        </div>
      </div>

      {isDocked && !fullscreen ? (
        <RegionSplitter
          edge="inline-end"
          label="调整辅助面板宽度"
          max={geometry.max}
          min={geometry.min}
          onActivity={onActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={geometry.size}
        />
      ) : null}
    </div>
  )
}
