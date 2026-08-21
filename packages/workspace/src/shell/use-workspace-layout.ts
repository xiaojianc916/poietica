import { createExternalStore } from '@poietica/core'
import { useSyncExternalStore } from 'react'

import { WORKSPACE_LAYOUT } from './workspace-layout'
import { useWorkspaceLayoutState } from './workspace-layout-store'

export type WorkspaceLayoutMode = 'wide' | 'compact' | 'narrow'

/*
 * 布局模式的唯一真相是视口自己：断点与 CSS 同一个坐标系，问宿主要一次就等于多一份会
 * 过期的副本。最小化因此不需要特例 —— CSS 视口不会缩到图标尺寸。
 */
const wideViewport = window.matchMedia(`(min-width: ${WORKSPACE_LAYOUT.breakpoints.wide}px)`)
const compactViewport = window.matchMedia(`(min-width: ${WORKSPACE_LAYOUT.breakpoints.compact}px)`)

function currentMode(): WorkspaceLayoutMode {
  if (wideViewport.matches) {
    return 'wide'
  }

  return compactViewport.matches ? 'compact' : 'narrow'
}

/*
 * 越界只发生在窗口正被拖拽的当口，一越界就通知会让主内容区左缘与指针手里的窗口边缘
 * 互相拉扯，所以等静止再通知；同一次提交里的消费者读到的是同一个模式。
 */
let settleTimer = 0

const store = createExternalStore<WorkspaceLayoutMode>({
  read: currentMode,
  activate: () => {
    const settle = (): void => {
      window.clearTimeout(settleTimer)

      settleTimer = window.setTimeout(() => {
        store.notify()
      }, WORKSPACE_LAYOUT.breakpoints.settleMs)
    }

    wideViewport.addEventListener('change', settle)
    compactViewport.addEventListener('change', settle)

    return () => {
      window.clearTimeout(settleTimer)
      wideViewport.removeEventListener('change', settle)
      compactViewport.removeEventListener('change', settle)
    }
  },
})

export function useWorkspaceLayoutMode(): WorkspaceLayoutMode {
  return useSyncExternalStore(store.subscribe, store.read)
}

/**
 * 侧边栏此刻是不是真的占着那一列。
 *
 * 「停靠」要两个条件同时成立：用户想要它开着，而窗口还容得下一列。store 只拥有
 * 前者 —— 窄窗口改用抽屉是呈现降级，意图一旦被环境覆盖就再也还原不回来。
 *
 * 外壳栅格的 data-sidebar-docked 与标题栏那截竖线读的都是它，判据只在这里一次。
 */
export function useIsSidebarDocked(): boolean {
  const mode = useWorkspaceLayoutMode()
  const { sidebarOpen } = useWorkspaceLayoutState()

  return mode !== 'narrow' && sidebarOpen
}
