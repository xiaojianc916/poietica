import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'

export type FeatureStore<S> = StoreApi<S>

export function createFeatureStore<S>(init: StateCreator<S, [], []>): FeatureStore<S> {
  return createStore<S>()(init)
}

/** 选择单个值用它 */
export function useFeatureStore<S, T>(store: FeatureStore<S>, selector: (s: S) => T): T {
  return useStore(store, selector)
}

/** 选择器返回新对象/数组时必须用它，否则每次渲染都会触发更新 */
export function useFeatureStoreShallow<S, T extends object>(store: FeatureStore<S>, selector: (s: S) => T): T {
  return useStore(store, useShallow(selector))
}
