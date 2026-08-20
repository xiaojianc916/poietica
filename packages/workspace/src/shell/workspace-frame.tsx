import { type MotionStyle, motion, useReducedMotion } from 'motion/react'
import type { ReactNode, Ref } from 'react'
import { WORKSPACE_LAYOUT } from './workspace-layout'
import type { SplitterActivity } from './workspace-layout-store'

import './workspace-shell.css'

type WorkspaceMotionStyle = MotionStyle & Record<`--${string}`, string | number>

const WORKSPACE_LAYOUT_STYLE: WorkspaceMotionStyle = {
  /*
   * 行几何的产品输入。设计系统据此算出行的前导内缩，而那道公式声明在
   * [data-ui-rows] 上 —— 自定义属性的 var() 在声明所在元素上求值，公式与
   * 输入因此必须同居一个元素。本组件同时提供两者：值在这里，标记在根节点的
   * data-ui-rows 上。少任何一个，所有行的图标都会贴到 hover 背景左边缘。
   */
  '--ui-row-icon-center': `${WORKSPACE_LAYOUT.sidebar.navIconCenter}px`,

  /*
   * 布局动画时长同时给 motion 的 transition 和 CSS 侧的过渡使用，两边共用
   * 一条时间轴：否则分隔线的渐隐会和面板滑动各跑各的节奏。
   */
  '--workspace-layout-duration': `${WORKSPACE_LAYOUT.motion.layoutDurationSeconds}s`,
  '--chrome-height': `${WORKSPACE_LAYOUT.chrome.height}px`,
}

export interface WorkspaceFrameProps {
  readonly rootRef?: Ref<HTMLDivElement>
  readonly chrome: ReactNode
  readonly sidebar: ReactNode
  readonly main: ReactNode
  readonly sidebarColumnWidth: number
  readonly isSidebarDocked: boolean
  readonly splitter: SplitterActivity
}

/**
 * 外壳栅格的动画所有者。
 *
 * 行与列的模板、命名区域、分隔线与空列的指针穿透都在 workspace-shell.css 里。
 * 这里把停靠状态位挂到根元素上，并渲染分隔线本身——它是栅格家具，归栅格的
 * 所有者持有，不归任何一侧的区域。
 */
export function WorkspaceFrame({
  rootRef,
  chrome,
  sidebar,
  main,
  sidebarColumnWidth,
  isSidebarDocked,
  splitter,
}: WorkspaceFrameProps) {
  const shouldReduceMotion = useReducedMotion()

  /* 拖拽中不补间：宽度每帧都在变，补间只会让线追不上指针。 */
  const isDragging = splitter === 'drag'

  /* 侧边栏停靠动画与 CSS 侧的竖线过渡共用一条时间轴。 */
  const transition =
    isDragging || shouldReduceMotion
      ? { duration: 0 }
      : {
          type: 'tween' as const,
          duration: WORKSPACE_LAYOUT.motion.layoutDurationSeconds,
          ease: WORKSPACE_LAYOUT.motion.layoutEase,
        }

  return (
    <motion.div
      animate={{
        '--workspace-sidebar-column-width': `${sidebarColumnWidth}px`,
      }}
      className="workspace-shell relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground"
      data-sidebar-docked={isSidebarDocked ? 'true' : 'false'}
      data-splitter={splitter}
      data-ui-rows=""
      initial={false}
      ref={rootRef}
      style={WORKSPACE_LAYOUT_STYLE}
      transition={transition}
    >
      {chrome}
      {sidebar}
      {main}
      <div aria-hidden="true" className="workspace-shell__divider" />
    </motion.div>
  )
}
