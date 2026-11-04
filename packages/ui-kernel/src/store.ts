import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'

export type FeatureStore<S> = StoreApi<S>
/**
 * 跨功能只读视图：订阅与取快照足够，不把 `setState` 交出去。服务令牌暴露 store 时用它，
 * 写入仍走提供方自己的方法。
 */
export type ReadonlyFeatureStore<S> = Pick<StoreApi<S>, 'getState' | 'getInitialState' | 'subscribe'>

export function createFeatureStore<S>(init: StateCreator<S, [], []>): FeatureStore<S> {
  return createStore<S>()(init)
}

export function useFeatureStore<S, T>(store: ReadonlyFeatureStore<S>, selector: (s: S) => T): T {
  return useStore(store, selector)
}

/** 选择器返回新对象/数组时必须用它，否则每次渲染都会触发更新 */
export function useFeatureStoreShallow<S, T extends object>(store: ReadonlyFeatureStore<S>, selector: (s: S) => T): T {
  return useStore(store, useShallow(selector))
}
