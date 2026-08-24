import { createExternalStore } from '@poietica/core'
import { useSyncExternalStore } from 'react'
import { WORKSPACE_LAYOUT } from './workspace-layout'
import { useWorkspaceLayoutState } from './workspace-layout-store'

/** 视口读数只从这里进来，于是下面那条规则可以脱离 DOM 单测。 */
export interface ViewportProbe {
  /** 当前视口内宽，逻辑像素。 */
  readonly measure: () => number
  /** 宽度变了报一次。回调必须在帧内、布局之后绘制之前送达。 */
  readonly observe: (report: (width: number) => void) => () => void
}

/*
 * 判据只有这一条：容得下一列侧边栏就停靠。
 *
 * 宽 0 是「没有布局视口」（窗口最小化时客户区 0×0），此刻问题不成立，维持上一次
 * 的答案：改了它，还原窗口时就要再改回来，而那一次改回来会被列宽补间演成一次
 * 可见的收起再展开。
 */
function decide(width: number, previous: boolean): boolean {
  return width === 0 ? previous : width >= WORKSPACE_LAYOUT.breakpoints.dockable
}

export function createDockingStore(probe: ViewportProbe) {
  let docked = decide(probe.measure(), true)

  return createExternalStore<boolean>({
    read: () => docked,

    activate: (notify) =>
      probe.observe((width) => {
        const next = decide(width, docked)

        if (next === docked) {
          return
        }

        docked = next
        notify()
      }),
  })
}

/*
 * 视口内宽只有一个产地：documentElement.clientWidth（CSSOM View 对视口宽度的
 * 定义）。用 ResizeObserver 而不是 resize / matchMedia change：观测在 update the
 * rendering 里、布局之后绘制之前送达，读到的宽度因此属于将要绘制的那一帧；后两者
 * 是普通任务，与布局无关，残留读数会被提交进一帧真实几何的画面。
 */
function viewportProbe(): ViewportProbe {
  const root = document.documentElement

  return {
    measure: () => root.clientWidth,

    observe: (report) => {
      const observer = new ResizeObserver(() => {
        report(root.clientWidth)
      })

      observer.observe(root)

      return () => {
        observer.disconnect()
      }
    },
  }
}

/* 一个进程一份，首次用到时才建：导入本模块不碰 document。 */
let store: ReturnType<typeof createDockingStore> | undefined

function dockingStore() {
  store ??= createDockingStore(viewportProbe())

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
