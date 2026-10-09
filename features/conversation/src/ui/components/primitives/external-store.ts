import { useSyncExternalStore } from 'react'

/*
 * React 之外的数据源，接线只有这一种形状。
 *
 * **逐字迁移**自 legacy 的 \`@poietica/external-store\`：接口、实现与注释里的判据都照旧。
 * 它之所以留在 UI 层而不是新开一个包：新架构里**功能状态**一律用 \`@poietica/ui-kernel\` 的
 * \`createFeatureStore\`（zustand，06 页 §5.8），剩下需要它的只有「某个组件自己的可观察量」
 * （时钟、设备像素比这类）；为这几处再开一个平台包，按 03 页 §2.2 的分层表没有位置。
 */

export interface ExternalStore<T> {
  /** 交给 useSyncExternalStore 的第一个参数，引用终生不变。 */
  readonly subscribe: (listen: () => void) => () => void
  /** 交给 useSyncExternalStore 的第二个参数：纯读当前值。 */
  readonly read: () => T
  /** 值已经换好之后叫一声。没有订阅者时是空操作。 */
  readonly notify: () => void
}

export interface ExternalStoreSource<T> {
  readonly read: () => T
  /**
   * 第一个订阅者到来时把真实来源接上，交回断开它的方法。
   * 末个订阅者离开时调用那个方法。没有真实来源要接时不必给。
   */
  readonly activate?: (notify: () => void) => (() => void) | undefined
}

export function createExternalStore<T>(source: ExternalStoreSource<T>): ExternalStore<T> {
  const listeners = new Set<() => void>()

  let detach: (() => void) | undefined

  const notify = (): void => {
    for (const listen of listeners) listen()
  }

  const subscribe = (listen: () => void): (() => void) => {
    listeners.add(listen)
    if (listeners.size === 1) detach = source.activate?.(notify)
    return () => {
      listeners.delete(listen)
      if (listeners.size === 0) {
        detach?.()
        detach = undefined
      }
    }
  }

  return { subscribe, read: source.read, notify }
}

/** React 绑定：与 legacy 的 useExternalStore 同形 */
export function useExternalStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.read)
}
