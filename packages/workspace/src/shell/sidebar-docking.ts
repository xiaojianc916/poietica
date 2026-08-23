import { createExternalStore } from '@poietica/core'
import { useSyncExternalStore } from 'react'
import { WORKSPACE_LAYOUT } from './workspace-layout'
import { useWorkspaceLayoutState } from './workspace-layout-store'

const { dockable, minInnerWidth, settleMs } = WORKSPACE_LAYOUT.breakpoints

/* 断点与 CSS 同一个坐标系：宽度由视口自己回答，不向宿主要第二份副本。 */
const dockableViewport = window.matchMedia(`(min-width: ${dockable}px)`)

/*
 * 最小化后宿主报回的客户区宽度是图标态残留，不是用户看到的视口：OS 只保证呈现中的
 * 窗口不窄于声明的最小内宽，低于它的读数一律不算宽度。
 */
function isViewportMeasurable(): boolean {
  return window.innerWidth >= minInnerWidth
}

/* 唯一真相是这份快照：读不到就保持上一次，于是最小化与还原不产生状态变化。 */
let hasRoom = isViewportMeasurable() ? dockableViewport.matches : true

const store = createExternalStore<boolean>({
  read: () => hasRoom,

  activate: (notify) => {
    let settleTimer = 0

    function sample(): void {
      if (!isViewportMeasurable() || dockableViewport.matches === hasRoom) {
        return
      }

      hasRoom = dockableViewport.matches
      notify()
    }

    /* 等几何静止再提交：OS 的模态缩放循环不转发指针状态，静止是页面内唯一的「拖拽结束」信号。 */
    function settle(): void {
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(sample, settleMs)
    }

    dockableViewport.addEventListener('change', settle)
    document.addEventListener('visibilitychange', settle)

    return () => {
      window.clearTimeout(settleTimer)
      dockableViewport.removeEventListener('change', settle)
      document.removeEventListener('visibilitychange', settle)
    }
  },
})

/** 窗口容不容得下一列停靠的侧边栏。 */
export function useCanDockSidebar(): boolean {
  return useSyncExternalStore(store.subscribe, store.read, store.read)
}

/** 侧边栏此刻是否真的占着那一列：容得下，且用户要它开着。判据只在这里合成。 */
export function useIsSidebarDocked(): boolean {
  const canDock = useCanDockSidebar()
  const { sidebarOpen } = useWorkspaceLayoutState()

  return canDock && sidebarOpen
}
