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

/*
 * 订阅同时挂在 matchMedia change 与 window resize 上，两者都只触发一次
 * 快照比对：快照不变时 useSyncExternalStore 不重渲染，代价是每帧两次
 * 布尔读取。本机实测 change 紧随越界派发（+0.1ms 量级）；resize 直采
 * 兜住的是派发时机的平台差异 —— matches 由引擎维护、永远同步于当前
 * 视口，「提交时的模式是当前视口的函数」因此成为结构保证，不依赖事件
 * 调度的及时性。
 *
 * 模式随越界立即提交，不等几何静止：等静止的代价已实测过 —— 静候
 * 180ms 的旧机制叠加拖拽尾巴后，从越界到列宽首动要 218–510ms，读感
 * 就是慢半拍、不跟手。
 */
function subscribe(listener: () => void): () => void {
  const queries = [
    mediaQuery(WORKSPACE_LAYOUT.breakpoints.wide),
    mediaQuery(WORKSPACE_LAYOUT.breakpoints.compact),
  ]

  for (const query of queries) {
    query.addEventListener('change', listener)
  }

  window.addEventListener('resize', listener)

  return () => {
    for (const query of queries) {
      query.removeEventListener('change', listener)
    }

    window.removeEventListener('resize', listener)
  }
}

export function useWorkspaceLayoutMode(): WorkspaceLayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot)
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
