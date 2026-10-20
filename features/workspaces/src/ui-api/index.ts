import { defineServiceToken } from '@poietica/foundation'
import { type FeatureStore, useFeatureStoreShallow } from '@poietica/ui-kernel'
import type { Workspace } from '../contract'

export interface WorkspacesState {
  readonly items: readonly Workspace[]
  readonly activeId: string | null
}

/**
 * 「当前项目」是**必选的**：没有任何项目时 `activeId` 为 null，入口页据此禁用发送。
 * `setActive` 也收 null —— 列表被清空（项目被移除、目录失效）时它要能回到「还没选」。
 */
export interface WorkspacesUi {
  readonly store: FeatureStore<WorkspacesState>
  active(): Workspace | null
  setActive(id: string | null): void
  subscribeActive(listener: (workspace: Workspace | null) => void): () => void
  pickAndAdd(): Promise<Workspace | null>
  /**
   * 从名单里移除这个项目（不删磁盘目录）。它底下的对话由 conversation 的级联删除，当前项目被删掉时
   * `activeId` 回到 null —— 「还没选项目」于是又成立，入口页照规矩禁用发送。
   */
  remove(id: string): Promise<void>
}
export const WorkspacesUiToken = defineServiceToken<WorkspacesUi>('workspaces', 'WorkspacesUi')

/* 工作区选择器（WorkspacePicker）只认 props、不持有工作区状态，住在 design-system：conversation（新对话输入框下方）与
 * automations（编辑器）各自从 `@poietica/design-system` 取，数据从本入口的 WorkspacesUi 拿。 */

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
