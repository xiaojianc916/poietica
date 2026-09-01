import { RegionSplitter } from '@poietica/design-system'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { workspaceLayoutStore } from '../workspace-layout-store'

export interface AuxiliaryRegionProps {
  readonly isDocked: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

/**
 * 辅助区域。与 SidebarRegion 镜像：定宽底面贴列的 inline-end 一侧，收起时列宽
 * 归零、内容被自己那一列裁掉，子树不卸载 —— 原生子 webview 不随开合销毁重建。
 */
export function AuxiliaryRegion({
  isDocked,
  width,
  onClose,
  onResize,
  children,
}: AuxiliaryRegionProps) {
  return (
    <div className="workspace-shell__auxiliary min-h-0 min-w-0 bg-background" inert={!isDocked}>
      <button
        aria-label="关闭辅助面板"
        className="workspace-shell__auxiliary-scrim"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div className="workspace-shell__region-clip">
        <div
          className="workspace-shell__auxiliary-content min-h-0 overflow-hidden"
          style={{ width }}
        >
          {children}
        </div>
      </div>

      {isDocked ? (
        <RegionSplitter
          edge="inline-end"
          label="调整辅助面板宽度"
          max={WORKSPACE_LAYOUT.auxiliary.maxWidth}
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
