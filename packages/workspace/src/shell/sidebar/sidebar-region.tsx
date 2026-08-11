import type { ReactNode } from 'react'
import type { WorkspaceLayoutMode } from '../use-workspace-layout'
import { WORKSPACE_LAYOUT } from '../workspace-layout'
import { SidebarSplitter } from './sidebar-splitter'

export interface SidebarRegionProps {
  readonly mode: WorkspaceLayoutMode
  readonly isOpen: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

/**
 * 侧边栏区域。
 *
 * 宽屏是栅格内的可拖拽列；窗口收窄过断点，它收起。可见性是用户意图，唯一
 * 所有者是 workspace-layout-store；呈现由布局模式在这里派生，扩回宽屏自然
 * 还原，不需要任何东西记得「刚才是不是开着」。
 *
 * 收起只有一种形态：列宽归零，内容留在原位被裁掉，子树不卸载。手动开合与
 * 跨断点开合因此走同一条呈现管线；列宽 tween 按墙钟推进，展开的第一帧若要
 * 同步重建整棵侧栏子树，丢掉的起步帧会让动画从半程上屏——呈现为顿一下再
 * 向右跳，而不是整体变慢。
 *
 * 收起态的不可交互由 inert 承担：overflow 裁剪不拦键盘焦点，聚焦还会把
 * 裁剪容器滚出内容；aria-hidden 不移出 Tab 序，挂着可聚焦内容反而违反
 * ARIA 对 aria-hidden 的要求。
 *
 * 栅格格位与空列的指针穿透由 workspace-shell.css 拥有，这里不再内联坐标。
 */
export function SidebarRegion({
  mode,
  isOpen,
  width,
  onClose,
  onResize,
  children,
}: SidebarRegionProps) {
  const isDocked = mode !== 'narrow' && isOpen

  return (
    <div
      className="workspace-shell__sidebar relative z-20 min-h-0 min-w-0 overflow-visible bg-sidebar"
      inert={!isDocked}
    >
      <div className="h-full min-h-0 w-full overflow-hidden">
        <div className="h-full min-h-0" style={{ width }}>
          {children}
        </div>
      </div>

      {isDocked ? (
        <SidebarSplitter
          max={WORKSPACE_LAYOUT.sidebar.maxWidth}
          min={WORKSPACE_LAYOUT.sidebar.minWidth}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
