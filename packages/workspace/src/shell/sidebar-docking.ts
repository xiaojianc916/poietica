import { createExternalStore } from '@poietica/core'
import { useSyncExternalStore } from 'react'
import { WORKSPACE_LAYOUT } from './workspace-layout'
import { useWorkspaceLayoutState } from './workspace-layout-store'

/** 视口读数只从这里进来，于是下面那条规则可以脱离 DOM 单测。 */
export interface ViewportProbe {
  /** 窗口容得下一列停靠的侧边栏。 */
  readonly hasRoom: () => boolean
  /** 窗口没在呈现（最小化、整幅遮挡）：此刻的几何读数不作数。 */
  readonly isHidden: () => boolean
  /** 几何或呈现状态可能变了就叫一声，不判断变没变。 */
  readonly watch: (notify: () => void) => () => void
}

/**
 * 停靠判据：每次通知都当场重算，不缓存派生事实。
 *
 * 唯一需要记住的是最小化期间维持上一次可信答案 —— 还原时那次通知会重新问，
 * 所以跨越断点不会被丢掉。丢一次就是永久丢一次：媒体查询在同一个方向上不会
 * 再响第二次。
 */
export function createDockingStore(probe: ViewportProbe) {
  let docked = probe.isHidden() ? true : probe.hasRoom()

  return createExternalStore<boolean>({
    read: () => docked,

    activate: (notify) =>
      probe.watch(() => {
        if (probe.isHidden() || probe.hasRoom() === docked) {
          return
        }

        docked = probe.hasRoom()
        notify()
      }),
  })
}

/* 断点与 CSS 同一个坐标系：宽度由视口自己回答，不向宿主要第二份副本。 */
function browserProbe(): ViewportProbe {
  const query = window.matchMedia(`(min-width: ${WORKSPACE_LAYOUT.breakpoints.dockable}px)`)

  return {
    hasRoom: () => query.matches,
    isHidden: () => document.hidden,

    /*
     * change 只在跨越那一刻响一次，而呈现状态与几何可以在页面收不到 change 时
     * 变化，所以 resize 与 visibilitychange 一并订上。多问几次的代价是一次布尔
     * 比较；少问一次的代价是自动收起时好时坏。
     */
    watch: (notify) => {
      query.addEventListener('change', notify)
      window.addEventListener('resize', notify)
      document.addEventListener('visibilitychange', notify)

      return () => {
        query.removeEventListener('change', notify)
        window.removeEventListener('resize', notify)
        document.removeEventListener('visibilitychange', notify)
      }
    },
  }
}

/* 一个进程一份，首次用到时才建：导入本模块不碰 window。 */
let store: ReturnType<typeof createDockingStore> | undefined

function dockingStore() {
  store ??= createDockingStore(browserProbe())

  return store
}

/** 窗口容不容得下一列停靠的侧边栏。 */
export function useCanDockSidebar(): boolean {
  const { subscribe, read } = dockingStore()

  return useSyncExternalStore(subscribe, read, read)
}

/** 侧边栏此刻是否真的占着那一列：容得下，且用户要它开着。判据只在这里合成。 */
export function useIsSidebarDocked(): boolean {
  const canDock = useCanDockSidebar()
  const { sidebarOpen } = useWorkspaceLayoutState()

  return canDock && sidebarOpen
}
