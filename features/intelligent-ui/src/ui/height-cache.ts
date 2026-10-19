/*
 * 量过的高度按（线程, 调用）记一份：时间线是虚拟列表，行滚出视口就卸载、iframe 跟着销毁；滚回来时
 * 先按记下的高度占位，界面重建（靠状态恢复）期间行高不变，列表不跳。
 *
 * 状态也照这个办法记一份（card.tsx）：卸载时最后那份写回 Core 还在路上，紧接着重建（滚回来、展开成对话框）
 * 的那个实例先读这里，不会读到旧的。
 *
 * 只是缓存：丢了不过是回到「先 1px、量到再露」/ 从 Core 读回。按最近使用淘汰，表长有上限（Map 必须有删除路径）。
 */
export interface RecentCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  readonly size: () => number
}

export type HeightCache = RecentCache<number>

export const HEIGHT_CACHE_LIMIT = 256

export function createHeightCache(limit = HEIGHT_CACHE_LIMIT): HeightCache {
  return createRecentCache<number>(limit)
}

export function createRecentCache<T>(limit: number): RecentCache<T> {
  const entries = new Map<string, T>()
  return {
    get(key) {
      const value = entries.get(key)
      if (value !== undefined) {
        entries.delete(key)
        entries.set(key, value)
      }
      return value
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      for (const oldest of entries.keys()) {
        if (entries.size <= limit) break
        entries.delete(oldest)
      }
    },
    size: () => entries.size,
  }
}
