import { RegionSplitter } from '@poietica/design-system'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { workspaceLayoutStore } from '../shell/workspace-layout-store'

export interface BrowserRegionProps {
  readonly isDocked: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

/**
 * 浏览器区域。与 SidebarRegion 镜像：定宽底面贴列的 inline-end 一侧，收起时列宽
 * 归零、内容被自己那一列裁掉，子树不卸载 —— 原生子 webview 不随开合销毁重建。
 */
export function BrowserRegion({
  isDocked,
  width,
  onClose,
  onResize,
  children,
}: BrowserRegionProps) {
  return (
    <div className="workspace-shell__browser min-h-0 min-w-0 bg-background" inert={!isDocked}>
      <div className="workspace-shell__region-clip">
        <div className="workspace-shell__browser-content min-h-0 overflow-hidden" style={{ width }}>
          {children}
        </div>
      </div>

      {isDocked ? (
        <RegionSplitter
          edge="inline-end"
          label="调整浏览器面板宽度"
          max={WORKSPACE_LAYOUT.browser.maxWidth}
          min={WORKSPACE_LAYOUT.browser.minWidth}
          onActivity={workspaceLayoutStore.setBrowserSplitterActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
