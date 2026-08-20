import { useSidebarResize } from './use-sidebar-resize'

export interface SidebarSplitterProps {
  readonly width: number
  readonly min: number
  readonly max: number
  readonly onResize: (width: number) => void
  readonly onCollapse: () => void
}

/**
 * 侧边栏分隔条。
 *
 * 元素用 hr：隐式 ARIA 角色就是 separator，可聚焦时按规范可携带 aria-valuenow，
 * 因此不需要显式 role。
 *
 * 它是一块命中区，不是一层涂料：自身永远透明，反馈归线本身（workspace-shell.css）。
 * 交互态由 useSidebarResize 写进 workspaceLayoutStore，外壳根节点上的 data-splitter
 * 是它唯一的读法，本组件因此不订阅任何状态。
 */
export function SidebarSplitter({ width, min, max, onResize, onCollapse }: SidebarSplitterProps) {
  const resize = useSidebarResize({ width, min, max, onResize, onCollapse })

  return (
    <hr
      aria-label="调整侧边栏宽度"
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={Math.round(width)}
      className="workspace-sidebar-splitter absolute -right-1 top-0 z-40 h-full w-2 cursor-col-resize touch-none select-none border-0 bg-transparent outline-none"
      onDoubleClick={resize.onDoubleClick}
      onKeyDown={resize.onKeyDown}
      onLostPointerCapture={resize.onLostPointerCapture}
      onPointerCancel={resize.onPointerCancel}
      onPointerDown={resize.onPointerDown}
      onPointerEnter={resize.onPointerEnter}
      onPointerLeave={resize.onPointerLeave}
      onPointerMove={resize.onPointerMove}
      onPointerUp={resize.onPointerUp}
      tabIndex={0}
    />
  )
}
