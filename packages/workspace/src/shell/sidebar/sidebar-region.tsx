import type { ReactNode } from 'react'
import { WORKSPACE_LAYOUT } from '../workspace-layout'
import { SidebarSplitter } from './sidebar-splitter'

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
 * 宽屏是栅格内的可拖拽列；窗口收窄过断点，它收起。可见性是用户意图，唯一
 * 所有者是 workspace-layout-store；呈现由布局模式在这里派生，扩回宽屏自然
 * 还原，不需要任何东西记得「刚才是不是开着」。
 *
 * 收起只有一种形态：列宽归零，主区盖过来，子树不卸载也不位移。手动开合与
 * 跨断点开合因此走同一条呈现管线；列宽 tween 按墙钟推进，展开的第一帧若要
 * 同步重建整棵侧栏子树，丢掉的起步帧会让动画从半程上屏——呈现为顿一下再
 * 向右跳，而不是整体变慢。
 *
 * 内容是一块定宽底面：永远铺在列的 inline-start 一侧，永远整幅落在视口内，
 * 收起时只是被不透明的主区遮住。揭示靠主区左缘退让，不靠裁剪也不靠平移：那
 * 两种写法都会把尚未露出的那条带子排除在绘制之外（cull rect 由视口与祖先裁剪
 * 算出），展开时必须当帧补画整棵侧栏子树，重内容界面上这笔预算抢不到，带子
 * 于是先以空白上屏。遮挡不参与绘制剔除，底面因此恒是画好的。
 *
 * 收起态的不可交互由 inert 承担：overflow 裁剪不拦键盘焦点，聚焦还会把
 * 裁剪容器滚出内容；aria-hidden 不移出 Tab 序，挂着可聚焦内容反而违反
 * ARIA 对 aria-hidden 的要求。
 *
 * 栅格格位与空列的指针穿透由 workspace-shell.css 拥有，这里不再内联坐标。
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
