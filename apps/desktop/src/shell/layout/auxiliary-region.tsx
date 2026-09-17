import { RegionSplitter } from '@poietica/design-system'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { useWorkspaceLayoutStore } from './layout-context'

export interface AuxiliaryRegionProps {
  readonly isDocked: boolean
  readonly fullscreen: boolean
  readonly width: number
  /** 宽度上限由侧边栏的停靠状态算出（见 auxiliaryMaxWidth），拖拽与钳制读同一份。 */
  readonly maxWidth: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

export function AuxiliaryRegion({
  isDocked,
  fullscreen,
  width,
  maxWidth,
  onClose,
  onResize,
  children,
}: AuxiliaryRegionProps) {
  const workspaceLayoutStore = useWorkspaceLayoutStore()

  return (
    <div className="workspace-shell__auxiliary min-h-0 min-w-0 bg-background" inert={!isDocked}>
      <div className="workspace-shell__region-clip">
        <div
          className="workspace-shell__auxiliary-content min-h-0 overflow-hidden"
          style={{ width: fullscreen ? '100%' : width }}
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
          onActivity={workspaceLayoutStore.setAuxiliarySplitterActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
