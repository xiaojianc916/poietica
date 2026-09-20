import { RegionSplitter } from '@poietica/design-system'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { useWorkspaceLayoutStore } from './layout-context'

export interface AuxiliaryRegionProps {
  readonly isDocked: boolean
  readonly fullscreen: boolean
  readonly width: number
  /** 宽度上限由侧边栏与窗口算出（见 auxiliaryMaxWidth），拖拽与钳制读同一份。 */
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
    <div className="workspace-shell__region workspace-shell__auxiliary bg-chrome" inert={!isDocked}>
      <div className="workspace-shell__region-clip">
        {/* 定宽内容贴 inline-end：留白由 CSS 给（内容自己的 margin-inline-end），宽度是
            这一份定值而不是列宽的百分比 —— 列被拖窄或收起时内容不重排，只从左边滑出去。
            全屏时列宽由外壳铺满，宽度交给 CSS 的 100% 上限算。 */}
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
          onActivity={workspaceLayoutStore.setAuxiliarySplitterActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
