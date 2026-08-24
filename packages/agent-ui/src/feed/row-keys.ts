import type { Presentation } from '@poietica/agent'

/**
 * 虚拟器的行身份表：序号 → 行 id，序列没变就交回同一个引用。
 *
 * 虚拟器的 measurements 备忘把 getItemKey 算进依赖，换一次身份就整表从 0 重建并重新分配。
 * 而投影每一拍都是新对象 —— 流式输出时行 id 一个都没变，重建纯属白做。所以身份表按内容
 * 比对一次，比对是 O(n) 的原始值比较，重建是 O(n) 的对象分配。
 *
 * 我不知道 React、不知道 DOM、不知道 store。只有 feed 允许调用我。
 */
export function reuseRowKeys(
  previous: readonly string[] | undefined,
  feed: Presentation,
): readonly string[] {
  const next = new Array<string>(feed.count)

  for (let index = 0; index < feed.count; index += 1) {
    next[index] = feed.rowAt(index)?.item.id ?? `row:${String(index)}`
  }

  if (previous === undefined || previous.length !== next.length) {
    return next
  }

  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      return next
    }
  }

  return previous
}
