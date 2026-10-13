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
  pickAndAdd(): Promise<Workspace | null>
  createScratch(): Promise<void>
}
export const WorkspacesUiToken = defineServiceToken<WorkspacesUi>('workspaces', 'WorkspacesUi')

/* 工作区选择器有两处落点（侧栏第一行由本功能自己画；新对话输入框下方那一行由 conversation 画），新架构里只有一份，住在这里，
 * conversation 经这个子入口取用。 */
export { type WorkspaceChoice, WorkspacePicker, type WorkspacePickerProps } from './workspace-picker'

/**
 * 一处的「项目名单 + 当前项目」，**订阅**着读。`WorkspacesUi.store` 是 zustand 的 vanilla store：getState() 拿到的是一次性快照。首帧时它还是
 * 空的（onCoreReady 里的加载还没回来），组件就再也不会重画 —— 屏幕上于是永远停在「选择项目」，要人手切一次页面才正常。选择器返回的是新
 * 数组/新对象，所以必须走 Shallow 那一支，否则每帧都判成「变了」。
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
