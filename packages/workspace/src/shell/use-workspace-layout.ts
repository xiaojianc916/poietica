import { useSyncExternalStore } from 'react'

import { WORKSPACE_LAYOUT } from './workspace-layout'
import { useWorkspaceLayoutState } from './workspace-layout-store'

export type WorkspaceLayoutMode = 'wide' | 'compact' | 'narrow'

/*
 * MediaQueryList 按查询串缓存：getSnapshot 会被频繁调用，不应每次都新建
 * 一个 MediaQueryList。惰性创建同时让本模块在无 DOM 的测试环境中可导入。
 */
const queryCache = new Map<string, MediaQueryList>()

function mediaQuery(query: string): MediaQueryList {
  const cached = queryCache.get(query)

  if (cached) {
    return cached
  }

  const created = window.matchMedia(query)

  queryCache.set(query, created)

  return created
}

function getSnapshot(): WorkspaceLayoutMode {
  if (mediaQuery(WORKSPACE_LAYOUT.breakpoints.wide).matches) {
    return 'wide'
  }

  if (mediaQuery(WORKSPACE_LAYOUT.breakpoints.compact).matches) {
    return 'compact'
  }

  return 'narrow'
}

function subscribe(listener: () => void): () => void {
  const queries = [
    mediaQuery(WORKSPACE_LAYOUT.breakpoints.wide),
    mediaQuery(WORKSPACE_LAYOUT.breakpoints.compact),
  ]

  for (const query of queries) {
    query.addEventListener('change', listener)
  }

  return () => {
    for (const query of queries) {
      query.removeEventListener('change', listener)
    }
  }
}

/*
 * 裸采样随断点越界立即翻转，而越界只发生在窗口正被拖拽缩放的当口——模式
 * 只由窗口宽度决定。探针数据（165Hz）显示补间本身逐帧平滑、跑满 0.22s，
 * 主线程全程无超过 50ms 的长任务：顿挫不是卡顿，而是叠加——一越界就提交，
 * 主内容区左缘随即在 220ms 内平移一整个列宽，与仍在指针手里移动的窗口
 * 边缘互相拉扯。手动开合丝滑是对照组：同一条补间，窗口静止就没有问题。
 *
 * 因此模式切换等几何静止：越界后 resize 停歇 settleMs 才提交，动画在静止
 * 窗口上播放，与手动开合走同一条呈现管线；拖拽期间布局保持原形态，仅被
 * 栅格 minmax 挤压。来回快速越界被合并为至多一次提交——实测出现过收起
 * 补间刚播完 20ms 就反向展开的背靠背抽搐，合并后不再存在。
 *
 * matchMedia 仍负责发现越界；resize 只在「越界后、静止前」的窗口内被监听，
 * 判定拖拽结束后立即移除。OS 的模态缩放循环不向页面转发指针状态，resize
 * 的停歇是页面内唯一可用的「拖拽结束」信号。
 *
 * 提交后的模式放在模块级而非各消费组件里：外壳栅格与标题栏必须在同一次
 * 提交中看到同一个模式，各自计时会让竖线、开合按钮与栅格错开一帧。
 */
const settleListeners = new Set<() => void>()

let settledMode: WorkspaceLayoutMode | null = null
let settleTimer = 0
let unsubscribeSample: (() => void) | null = null

function commitSettledMode(): void {
  window.removeEventListener('resize', deferSettledMode)

  /*
   * 最小化护栏。任务栏最小化会把窗口缩成图标尺寸，WebView 将其当作真实
   * resize 透传（实测 1303 -> 144px），断点随之翻成 narrow：还原窗口的第一帧
   * 是被收起的侧栏，然后再当着用户的面展开一遍。低于视口下限的几何不可能
   * 出自用户缩放 —— 丢弃采样，保持上一个已提交的模式；还原后的采样与其一
   * 致，于是什么也不发生。
   */
  if (window.innerWidth < WORKSPACE_LAYOUT.breakpoints.viewportFloor) {
    return
  }

  const next = getSnapshot()

  if (next === settledMode) {
    return
  }

  settledMode = next

  for (const listener of settleListeners) {
    listener()
  }
}

function deferSettledMode(): void {
  window.clearTimeout(settleTimer)

  settleTimer = window.setTimeout(commitSettledMode, WORKSPACE_LAYOUT.breakpoints.settleMs)
}

function onSampledModeChange(): void {
  /* 对同一回调重复 addEventListener 会被事件目标去重，连续越界也只挂一份。 */
  window.addEventListener('resize', deferSettledMode)
  deferSettledMode()
}

function subscribeSettled(listener: () => void): () => void {
  if (settleListeners.size === 0) {
    settledMode = getSnapshot()
    unsubscribeSample = subscribe(onSampledModeChange)
  }

  settleListeners.add(listener)

  return () => {
    settleListeners.delete(listener)

    if (settleListeners.size === 0) {
      unsubscribeSample?.()
      unsubscribeSample = null
      window.clearTimeout(settleTimer)
      window.removeEventListener('resize', deferSettledMode)
      settledMode = null
    }
  }
}

function getSettledSnapshot(): WorkspaceLayoutMode {
  return settledMode ?? getSnapshot()
}

export function useWorkspaceLayoutMode(): WorkspaceLayoutMode {
  return useSyncExternalStore(subscribeSettled, getSettledSnapshot)
}

/**
 * 侧边栏此刻是不是真的占着那一列。
 *
 * 「停靠」要两个条件同时成立：用户想要它开着，而视口还容得下一列。store 只拥有
 * 前者 —— 窄视口改用抽屉是呈现降级，意图一旦被环境覆盖就再也还原不回来。
 *
 * 判据只在这里出现一次。外壳栅格的 data-sidebar-docked、以及标题栏里那截竖线，
 * 读的都是它：此前后者读的是裸 sidebarOpen，于是拖窄窗口自动收起时，同一条线的
 * 两段各走各的 —— 下面那段淡掉了，chrome 行那截还亮着。
 */
export function useIsSidebarDocked(): boolean {
  const mode = useWorkspaceLayoutMode()
  const { sidebarOpen } = useWorkspaceLayoutState()

  return mode !== 'narrow' && sidebarOpen
}
