import type { BrowserState } from '../contract'
import type { BrowserApi } from './api'

/** 面板读的那一份标签面。状态不住在 React 里：驱动提示与命令都要在面板没挂载时读到它。revision 是宿主给的单调计数，乱序或重复送达时丢掉更旧的那一份，屏幕上就不会闪回上一步。 */
export interface BrowserPanelStore {
  snapshot(): BrowserState | null
  subscribe(listener: () => void): () => void
  apply(next: BrowserState): void
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
