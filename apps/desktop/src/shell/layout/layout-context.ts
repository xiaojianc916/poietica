import { createContext, useContext, useSyncExternalStore } from 'react'
import type { WorkspaceLayoutState, WorkspaceLayoutStore } from './layout-store'

export const WorkspaceLayoutContext = createContext<WorkspaceLayoutStore | null>(null)
export function useWorkspaceLayoutStore(): WorkspaceLayoutStore {
  const store = useContext(WorkspaceLayoutContext)
  if (store === null) {
    throw new Error('Workspace layout must be supplied by the application.')
  }
  return store
}
export function useWorkspaceLayoutState(): WorkspaceLayoutState {
  const store = useWorkspaceLayoutStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/**
 * 只订布局快照里的一格。
 *
 * 拖拽是 pointermove 频率的通报，全量订阅者（标题栏、工作台、右栏）会跟着每一帧
 * 重渲染。选择器必须返回引用稳定的值 —— 原始值或快照里现成的引用；现场构造的
 * 对象或数组每次都是新引用，等于没订。
 */
export function useWorkspaceLayoutValue<T>(selector: (state: WorkspaceLayoutState) => T): T {
  const store = useWorkspaceLayoutStore()
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  )
}
