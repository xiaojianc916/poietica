import { useSyncExternalStore } from 'react'

/*
 * 功能状态一律用 `@poietica/ui-kernel` 的 `createFeatureStore`；这里只剩「某个组件自己的可观察量」。
 */

export interface ExternalStore<T> {
  /** useSyncExternalStore 的第一个参数，引用终生不变。 */
  readonly subscribe: (listen: () => void) => () => void
  /** useSyncExternalStore 的第二个参数：纯读。 */
  readonly read: () => T
  /** 值换好之后叫一声。没有订阅者时是空操作。 */
  readonly notify: () => void
}

export interface ExternalStoreSource<T> {
  readonly read: () => T
  /** 第一个订阅者到来时接上真实来源，末个离开时断开。没有真实来源要接时不必给。 */
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

export function useExternalStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.read)
}
