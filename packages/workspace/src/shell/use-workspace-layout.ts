import { createExternalStore } from '@poietica/core'
import { useSyncExternalStore } from 'react'

import { WORKSPACE_LAYOUT } from './workspace-layout'
import { useWorkspaceLayoutState } from './workspace-layout-store'

export type WorkspaceLayoutMode = 'wide' | 'compact' | 'narrow'

/** 宿主推来的可见几何。宿主是唯一写入方。 */
export interface WindowGeometry {
  readonly width: number
}

function modeOf(width: number): WorkspaceLayoutMode {
  const { compact, wide } = WORKSPACE_LAYOUT.breakpoints

  if (width >= wide) {
    return 'wide'
  }

  return width >= compact ? 'compact' : 'narrow'
}

/*
 * 提交后的模式放在模块级而非各消费组件里：外壳栅格与标题栏必须在同一次提交
 * 中看到同一个模式，各自计时会让竖线、开合按钮与栅格错开一帧。
 */
let mode: WorkspaceLayoutMode = 'wide'
let established = false
let settleTimer = 0

const store = createExternalStore<WorkspaceLayoutMode>({ read: () => mode })

function commit(next: WorkspaceLayoutMode): void {
  if (next === mode) {
    return
  }

  mode = next
  store.notify()
}

/**
 * 宿主几何的唯一入口，由桌面壳在引导时接到原生事件上。
 *
 * 首份几何在窗口呈现之前到达，直接落定；此后的变化等静止再提交——越界只发生在
 * 窗口正被拖拽的当口，一越界就提交会让主内容区左缘与指针手里的窗口边缘互相拉扯。
 * 来回快速越界因此被合并成至多一次提交。
 */
export function observeWindowGeometry({ width }: WindowGeometry): void {
  const next = modeOf(width)

  window.clearTimeout(settleTimer)

  if (!established) {
    established = true
    commit(next)

    return
  }

  if (next === mode) {
    return
  }

  settleTimer = window.setTimeout(() => {
    commit(next)
  }, WORKSPACE_LAYOUT.breakpoints.settleMs)
}

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
