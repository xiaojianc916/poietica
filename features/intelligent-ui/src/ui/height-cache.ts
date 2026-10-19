/*
 * 量过的高度按（线程, 调用）记一份：时间线是虚拟列表，行滚出视口就卸载、iframe 跟着销毁；滚回来时
 * 先按记下的高度占位，界面重建（靠状态恢复）期间行高不变，列表不跳。
 *
 * 只是缓存：丢了不过是回到「先 1px、量到再露」。按最近使用淘汰，表长有上限（Map 必须有删除路径）。
 */
export interface HeightCache {
  get(key: string): number | undefined
  set(key: string, height: number): void
  readonly size: () => number
}

export const HEIGHT_CACHE_LIMIT = 256

export function createHeightCache(limit = HEIGHT_CACHE_LIMIT): HeightCache {
  const heights = new Map<string, number>()
  return {
    get(key) {
      const height = heights.get(key)
      if (height !== undefined) {
        heights.delete(key)
        heights.set(key, height)
      }
      return height
    },
    set(key, height) {
      heights.delete(key)
      heights.set(key, height)
      for (const oldest of heights.keys()) {
        if (heights.size <= limit) break
        heights.delete(oldest)
      }
    },
    size: () => heights.size,
  }
}
