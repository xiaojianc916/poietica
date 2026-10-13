import type { SplitterActivity, SplitterRegion } from '@poietica/ui-kernel'
import type { CSSProperties, ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from '../layout'

type WorkspaceStyle = CSSProperties & Record<`--${string}`, string | number>

const [easeX1, easeY1, easeX2, easeY2] = WORKSPACE_LAYOUT.motion.layoutEase

const WORKSPACE_LAYOUT_STYLE: WorkspaceStyle = {
  '--ui-row-icon-center': `${WORKSPACE_LAYOUT.sidebar.navIconCenter}px`,

  /* 列宽过渡与分隔线渐隐共用一条时间轴。 */
  '--workspace-layout-duration': `${WORKSPACE_LAYOUT.motion.layoutDurationSeconds}s`,
  '--workspace-layout-ease': `cubic-bezier(${easeX1}, ${easeY1}, ${easeX2}, ${easeY2})`,

  '--chrome-height': `${WORKSPACE_LAYOUT.chrome.height}px`,

  /* 卡片几何：外壳、右栏标签条与浏览器视口共读这一份。 */
  '--workspace-card-gap': `${WORKSPACE_LAYOUT.card.gap}px`,
  '--workspace-card-radius': `${WORKSPACE_LAYOUT.card.cornerRadius}px`,
  '--workspace-card-control': `${WORKSPACE_LAYOUT.card.controlSize}px`,
}

export interface WorkspaceFrameProps {
  readonly chrome: ReactNode
  /**
   * 页面之上的浮层。挂在根节点**之内**才读得到根上的自定义属性（如 `--chrome-height`，
   * 由这里的内联 style 写）；定位于视口的浮层是脱流的，不会给这个 grid 造出任何一行。
   */
  readonly overlays: ReactNode
  readonly sidebar: ReactNode
  readonly mainControls: ReactNode
  readonly main: ReactNode
  readonly auxiliary: ReactNode
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
  overlays,
  sidebar,
  mainControls,
  main,
  auxiliary,
  sidebarColumnWidth,
  auxiliaryColumnWidth,
  isSidebarDocked,
  isAuxiliaryDocked,
  isAuxiliaryFullscreen,
  splitter,
  splitterRegion,
}: WorkspaceFrameProps): ReactNode {
  /*
   * 全屏把 aux 列宽铺到剩余全部。只能用视口单位：这条属性注册成 <length>，1fr 不是长度、
   * 整条声明会失效并退回 0px；cqw 要给外壳加 container-type，那会造出包含块、把 fixed 的浮层关进外壳里。
   */
  const style: WorkspaceStyle = {
    ...WORKSPACE_LAYOUT_STYLE,
    '--workspace-sidebar-column-width': `${sidebarColumnWidth}px`,
    '--workspace-auxiliary-column-width': isAuxiliaryFullscreen
      ? 'calc(100dvw - var(--workspace-sidebar-column-width))'
      : `${auxiliaryColumnWidth}px`,
  }

  return (
    <div
      className="workspace-shell relative grid h-full w-full min-h-0 overflow-hidden bg-background text-foreground"
      data-auxiliary-docked={isAuxiliaryDocked ? 'true' : 'false'}
      data-auxiliary-fullscreen={isAuxiliaryFullscreen ? 'true' : 'false'}
      data-sidebar-docked={isSidebarDocked ? 'true' : 'false'}
      data-splitter={splitter}
      data-splitter-region={splitterRegion}
      /* 两枚稳定标记：data-ui-rows 是 --ui-row-lead 公式的锚（见 tokens/rows.css），
       * data-workbench 是外壳挂载点的测试锚。 */
      data-ui-rows=""
      data-workbench=""
      style={style}
    >
      {chrome}
      {overlays}
      {sidebar}
      {mainControls}
      {main}
      {auxiliary}
      <div aria-hidden="true" className="workspace-shell__divider" />
      <div aria-hidden="true" className="workspace-shell__divider workspace-shell__divider--auxiliary" />
    </div>
  )
}
