import { RegionSplitter } from '@poietica/ui'
import type { ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from '../workspace-layout'
import { workspaceLayoutStore } from '../workspace-layout-store'

export interface SidebarRegionProps {
  readonly isDocked: boolean
  readonly width: number
  readonly onClose: () => void
  readonly onResize: (width: number) => void
  readonly children: ReactNode
}

/**
 * 侧边栏区域。
 *
 * 可见性是用户意图，唯一所有者是 workspace-layout-store；呈现由布局模式在这里
 * 派生，扩回宽屏自然还原。
 *
 * 收起只有一种形态：列宽归零，主区盖过来，子树不卸载也不位移。内容是一块定宽
 * 底面，永远整幅落在视口内 —— 揭示靠主区左缘退让，不靠裁剪也不靠平移：那两种
 * 写法都会把尚未露出的那条带子排除在绘制之外，展开时必须当帧补画整棵子树。
 *
 * 收起态的不可交互由 inert 承担：overflow 裁剪不拦键盘焦点，aria-hidden 不移出
 * Tab 序且挂着可聚焦内容违反 ARIA 要求。
 */
export function SidebarRegion({
  isDocked,
  width,
  onClose,
  onResize,
  children,
}: SidebarRegionProps) {
  return (
    <div
      className="workspace-shell__sidebar min-h-0 min-w-0 overflow-visible bg-sidebar"
      inert={!isDocked}
    >
      <div
        className="workspace-shell__sidebar-content h-full min-h-0 overflow-hidden"
        style={{ width }}
      >
        {children}
      </div>

      {isDocked ? (
        <RegionSplitter
          edge="inline-start"
          label="调整侧边栏宽度"
          max={WORKSPACE_LAYOUT.sidebar.maxWidth}
          min={WORKSPACE_LAYOUT.sidebar.minWidth}
          onActivity={workspaceLayoutStore.setSplitterActivity}
          onCollapse={onClose}
          onResize={onResize}
          width={width}
        />
      ) : null}
    </div>
  )
}
