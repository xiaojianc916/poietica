import type { BrowserState } from '../contract'
import type { BrowserApi } from './api'

/**
 * 面板读的那一份标签面。
 *
 * 状态自己不住在 React 里：驱动提示（`driven`）与命令都要在面板没挂载时也能读到它，
 * 所以订阅写在 setup（见 ui/index.tsx），组件只订阅这一份快照。
 *
 * revision 是宿主给的单调计数：通知是 16ms 合批送出的，乱序或重复送达时丢掉更旧的
 * 那一份，屏幕上就不会闪回上一步（07 页 §12B 的注释）。
 */
export interface BrowserPanelStore {
  snapshot(): BrowserState | null
  subscribe(listener: () => void): () => void
  /** 收下一份状态；比当前更旧的 revision 直接丢弃 */
  apply(next: BrowserState): void
  /** 主动拉一次快照（首次装配、Core 每次 ready） */
  refresh(): Promise<void>
  dispose(): void
}

export function createBrowserPanelStore(api: BrowserApi): BrowserPanelStore {
  let state: BrowserState | null = null
  const listeners = new Set<() => void>()

  const publish = (): void => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    apply(next) {
      if (state !== null && next.revision < state.revision) {
        return
      }

      state = next
      publish()
    },
    async refresh() {
      const next = await api.state()

      // 拉回来的快照可能与通知交错：同一道 revision 闸门管着两条路。
      if (state === null || next.revision >= state.revision) {
        state = next
        publish()
      }
    },
    dispose() {
      listeners.clear()
    },
  }
}
