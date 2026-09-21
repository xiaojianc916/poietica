import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import type { CSSProperties, ReactNode } from 'react'
import type { SplitterActivity, SplitterRegion } from './layout-store'

import './workspace-shell.css'

type WorkspaceStyle = CSSProperties & Record<`--${string}`, string | number>

const [easeX1, easeY1, easeX2, easeY2] = WORKSPACE_LAYOUT.motion.layoutEase

const WORKSPACE_LAYOUT_STYLE: WorkspaceStyle = {
  '--ui-row-icon-center': `${WORKSPACE_LAYOUT.sidebar.navIconCenter}px`,

  /* 列宽过渡与分隔线渐隐共用一条时间轴：两边读同一份时长与同一条曲线。 */
  '--workspace-layout-duration': `${WORKSPACE_LAYOUT.motion.layoutDurationSeconds}s`,
  '--workspace-layout-ease': `cubic-bezier(${easeX1}, ${easeY1}, ${easeX2}, ${easeY2})`,

  '--chrome-height': `${WORKSPACE_LAYOUT.chrome.height}px`,

  /* 卡片几何：外壳、右栏标签条与浏览器视口（packages/workspace 自己）共读这一份。 */
  '--workspace-card-gap': `${WORKSPACE_LAYOUT.card.gap}px`,
  '--workspace-card-radius': `${WORKSPACE_LAYOUT.card.cornerRadius}px`,
  '--workspace-card-control': `${WORKSPACE_LAYOUT.card.controlSize}px`,
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
  readonly isAuxiliaryFullscreen: boolean
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
  isAuxiliaryFullscreen,
  splitter,
  splitterRegion,
}: WorkspaceFrameProps) {
  /*
   * 全屏把 aux 列宽铺到「剩余全部」：main 的 1fr 被逐帧压到 0，主区随之让位。
   * 两者都是 <length>，经 @property 插值过渡 —— 与侧边栏开合同一套机制。
   *
   * 算式只能用视口单位，不能用更贴切的 1fr 或 100cqw：
   * 这条属性注册成 <length>，1fr 不是长度，整条声明会失效并退回 initial-value 0px；
   * cqw 要给外壳加 container-type，而那会造出一个包含块，把 dialog / toast 那些
   * fixed inset-0 的浮层关进外壳里。外壳是整窗元素、根上又没有滚动条
   * （app.css 的 body overflow: hidden），所以 dvw 与它的实际宽度相等。
   */
  const style: WorkspaceStyle = {
    ...WORKSPACE_LAYOUT_STYLE,
    '--workspace-sidebar-column-width': `${sidebarColumnWidth}px`,
    '--workspace-auxiliary-column-width': isAuxiliaryFullscreen
      ? `calc(100dvw - var(--workspace-sidebar-column-width))`
      : `${auxiliaryColumnWidth}px`,
  }

  return (
    <div
      className="workspace-shell relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground"
      data-auxiliary-docked={isAuxiliaryDocked ? 'true' : 'false'}
      data-auxiliary-fullscreen={isAuxiliaryFullscreen ? 'true' : 'false'}
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
