import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { CSSProperties, ReactNode } from 'react'
import type { SplitterActivity, SplitterRegion } from './layout-store'

import '../workspace-shell.css'

type WorkspaceStyle = CSSProperties & Record<`--${string}`, string | number>

const [easeX1, easeY1, easeX2, easeY2] = WORKSPACE_LAYOUT.motion.layoutEase

const WORKSPACE_LAYOUT_STYLE: WorkspaceStyle = {
  '--ui-row-icon-center': `${WORKSPACE_LAYOUT.sidebar.navIconCenter}px`,

  /* 列宽过渡与分隔线渐隐共用一条时间轴：两边读同一份时长与同一条曲线。 */
  '--workspace-layout-duration': `${WORKSPACE_LAYOUT.motion.layoutDurationSeconds}s`,
  '--workspace-layout-ease': `cubic-bezier(${easeX1}, ${easeY1}, ${easeX2}, ${easeY2})`,

  '--chrome-height': `${WORKSPACE_LAYOUT.chrome.height}px`,
}

export interface WorkspaceFrameProps {
  readonly chrome: ReactNode
  readonly sidebar: ReactNode
  readonly main: ReactNode
  readonly auxiliary: ReactNode
  readonly mainControls: ReactNode
  readonly sidebarColumnWidth: number
  readonly auxiliaryColumnWidth: number
  readonly isSidebarDocked: boolean
  readonly isAuxiliaryDocked: boolean
  readonly splitter: SplitterActivity
  readonly splitterRegion: SplitterRegion
}

export function WorkspaceFrame({
  chrome,
  sidebar,
  main,
  auxiliary,
  mainControls,
  sidebarColumnWidth,
  auxiliaryColumnWidth,
  isSidebarDocked,
  isAuxiliaryDocked,
  splitter,
  splitterRegion,
}: WorkspaceFrameProps) {
  const style: WorkspaceStyle = {
    ...WORKSPACE_LAYOUT_STYLE,
    '--workspace-sidebar-column-width': `${sidebarColumnWidth}px`,
    '--workspace-auxiliary-column-width': `${auxiliaryColumnWidth}px`,
  }

  return (
    <div
      className="workspace-shell relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground"
      data-auxiliary-docked={isAuxiliaryDocked ? 'true' : 'false'}
      data-sidebar-docked={isSidebarDocked ? 'true' : 'false'}
      data-splitter={splitter}
      data-splitter-region={splitterRegion}
      data-ui-rows=""
      style={style}
    >
      {chrome}
      {sidebar}
      {mainControls}
      {main}
      {auxiliary}
      <div aria-hidden="true" className="workspace-shell__divider" />
      <div
        aria-hidden="true"
        className="workspace-shell__divider workspace-shell__divider--auxiliary"
      />
    </div>
  )
}
