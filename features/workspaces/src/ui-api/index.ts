/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { defineServiceToken } from '@poietica/foundation'
import { type FeatureStore, useFeatureStoreShallow } from '@poietica/ui-kernel'
import type { Workspace } from '../contract'

export interface WorkspacesState {
  readonly items: readonly Workspace[]
  readonly activeId: string | null
}

export interface WorkspacesUi {
  readonly store: FeatureStore<WorkspacesState>
  active(): Workspace | null
  setActive(id: string | null): void
  subscribeActive(listener: (workspace: Workspace | null) => void): () => void
  /** dialog.pickFolder → workspaces.add */
  pickAndAdd(): Promise<Workspace | null>
  /** 新建一个临时工作区并切过去（「不在项目中工作」在新数据模型下的落点）。 */
  createScratch(): Promise<void>
}
export const WorkspacesUiToken = defineServiceToken<WorkspacesUi>('workspaces', 'WorkspacesUi')

/*
 * 选择器本体也从这个子入口出去。
 *
 * 03 页 §4.4：ui-api 可以导出「贡献点、服务令牌、可复用组件」。工作区选择器有两处落点
 * （侧栏第一行由本功能自己画；新对话输入框下方那一行由 conversation 画），legacy 里它是
 * 同一份组件——新架构里同样只有一份，住在这里，conversation 经这个子入口取用。
 */
export { type WorkspaceChoice, WorkspacePicker, type WorkspacePickerProps } from './workspace-picker'

/**
 * 一处的「项目名单 + 当前项目」，**订阅**着读。
 *
 * WorkspacesUi.store 是 zustand 的 vanilla store：getState() 拿到的是一次性快照。
 * 首帧时它还是空的（onCoreReady 里的 eload() 还没回来），拿快照的组件渲染完那一次
 * 就再也不会重画 —— 屏幕上于是永远停在「选择项目」，要人手切一次页面（组件重挂）才正常。
 * 这条与 conversation 侧线程列表那条是同一个坑（见 useFeatureStoreShallow 的头注）。
 *
 * 选择器返回的是新数组/新对象，所以必须走 Shallow 那一支，否则每帧都判成「变了」。
 */
export function useWorkspacesView(ui: WorkspacesUi): {
  readonly items: readonly Workspace[]
  readonly active: Workspace | null
  readonly activeId: string | null
} {
  const { items, activeId } = useFeatureStoreShallow(ui.store, (held) => ({
    items: held.items,
    activeId: held.activeId,
  }))

  return { items, active: items.find((w) => w.id === activeId) ?? null, activeId }
}
