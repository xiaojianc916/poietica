import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { UpdateState } from '../contract'

/**
 * 更新界面这一份状态。三个字段各有各的寿数：`state` 是 Host 状态机的只读投影（UI 不自己推演相位）；`dismissed` 是**本次运行内**的
 * 「稍后」记忆，不落盘也不参与相位判断，只决定横幅画不画；`latest` 是**手动检查刚回话「已是最新」**的一次性标记 —— `idle` 既可能是
 * 「从没查过」也可能是「查过、没有新版本」，Host 分不出来，所以由发起检查的那一侧记在这里，横幅报完由 `clearLatest` 清掉。
 */
export interface UpdateUiState {
  readonly state: UpdateState | null
  readonly dismissed: string | null
  readonly latest: boolean
}

export interface UpdateUiStore {
  readonly store: FeatureStore<UpdateUiState>
  apply(state: UpdateState): void
  dismiss(version: string): void
  announceLatest(): void
  clearLatest(): void
}

export function createUpdateStore(initial: UpdateState | null = null): UpdateUiStore {
  const store = createFeatureStore<UpdateUiState>(() => ({ state: initial, dismissed: null, latest: false }))
  return {
    store,
    apply(state) {
      store.setState({ state })
    },
    dismiss(version) {
      store.setState({ dismissed: version })
    },
    announceLatest() {
      store.setState({ latest: true })
    },
    clearLatest() {
      store.setState({ latest: false })
    },
  }
}
