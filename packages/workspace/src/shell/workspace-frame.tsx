import type { CSSProperties, ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from './workspace-layout'
import type { SplitterActivity, SplitterRegion } from './workspace-layout-store'

import './workspace-shell.css'

type WorkspaceStyle = CSSProperties & Record<`--${string}`, string | number>

const [easeX1, easeY1, easeX2, easeY2] = WORKSPACE_LAYOUT.motion.layoutEase

const WORKSPACE_LAYOUT_STYLE: WorkspaceStyle = {
  /*
   * 行几何的产品输入。设计系统据此算出行的前导内缩，而那道公式声明在
   * [data-ui-rows] 上 —— 自定义属性的 var() 在声明所在元素上求值，公式与
   * 输入因此必须同居一个元素。本组件同时提供两者：值在这里，标记在根节点的
   * data-ui-rows 上。少任何一个，所有行的图标都会贴到 hover 背景左边缘。
   */
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
  readonly browser: ReactNode
  readonly sidebarColumnWidth: number
  readonly browserColumnWidth: number
  readonly isSidebarDocked: boolean
  readonly isBrowserDocked: boolean
  readonly splitter: SplitterActivity
  readonly splitterRegion: SplitterRegion
}

/**
 * 外壳栅格的所有者。
 *
 * 两列列宽在 React 提交时就写进内联自定义属性：栅格模板每一帧都能从 DOM 读到真
 * 值，插值归 CSS 引擎、与样式解析同帧。没有一帧的几何取决于"动画引擎有没有来得
 * 及写值"，窗口显示与还原因此不会先画出收起态。
 *
 * 行与列的模板、命名区域、分隔线与空列的指针穿透都在 workspace-shell.css 里。
 * 这里把停靠状态位挂到根元素上，并渲染分隔线本身——它是栅格家具，归栅格的
 * 所有者持有，不归任何一侧的区域。
 */
export function WorkspaceFrame({
  chrome,
  sidebar,
  main,
  browser,
  sidebarColumnWidth,
  browserColumnWidth,
  isSidebarDocked,
  isBrowserDocked,
  splitter,
  splitterRegion,
}: WorkspaceFrameProps) {
  const style: WorkspaceStyle = {
    ...WORKSPACE_LAYOUT_STYLE,
    '--workspace-sidebar-column-width': `${sidebarColumnWidth}px`,
    '--workspace-browser-column-width': `${browserColumnWidth}px`,
  }

  return (
    <div
      className="workspace-shell relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground"
      data-browser-docked={isBrowserDocked ? 'true' : 'false'}
      data-sidebar-docked={isSidebarDocked ? 'true' : 'false'}
      data-splitter={splitter}
      data-splitter-region={splitterRegion}
      data-ui-rows=""
      style={style}
    >
      {chrome}
      {sidebar}
      {main}
      {browser}
      <div aria-hidden="true" className="workspace-shell__divider" />
      <div
        aria-hidden="true"
        className="workspace-shell__divider workspace-shell__divider--browser"
      />
    </div>
  )
}
