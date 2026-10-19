/* 画过的图按源码留下 SVG 字符串：所在行会被虚拟器卸载，没有这一份，滚回来就要重跑布局引擎
   （主线程上几十到几百毫秒），而且行高先源码面板、再变成图，虚拟器收到两次尺寸变化、位置跟着跳。
   存字符串不存节点：同一个节点不能同时挂在两处。 */
const SVG_ENTRIES = 64
const SVG_CHARS = 4_000_000

const svgs = new Map<string, string>()
let chars = 0

/* 键只有源码：pele 交回的 svg 里颜色全是 var(--pele-*) 引用，换主题是 CSS 的事，不该再重画一张。 */
export function svgKey(code: string): string {
  return code
}

/** 命中即算一次使用：挪到最近端，淘汰最后才轮到它。 */
export function cachedSvg(key: string): string | undefined {
  const found = svgs.get(key)

  if (found !== undefined) {
    svgs.delete(key)
    svgs.set(key, found)
  }

  return found
}

/** 只看一眼，不动使用顺序：渲染期读缓存必须是纯的（真正的使用由随后的 effect 记）。 */
export function peekSvg(key: string): string | undefined {
  return svgs.get(key)
}

/** 只收成功的：失败不缓存，下次还要重试（引擎的失败原因未必稳定）。 */
export function keepSvg(key: string, svg: string): void {
  const previous = svgs.get(key)

  if (previous !== undefined) {
    chars -= previous.length
    svgs.delete(key)
  }

  svgs.set(key, svg)
  chars += svg.length

  for (const [oldest, value] of svgs) {
    if (svgs.size <= SVG_ENTRIES && chars <= SVG_CHARS) {
      break
    }

    /* 刚写进来的那一条一定留下：它正是接下来要用的。 */
    if (oldest === key) {
      break
    }

    svgs.delete(oldest)
    chars -= value.length
  }
}

/** 仅测试使用：模块级缓存跨用例留着，淘汰顺序就不可预期。 */
export function resetDiagramCacheForTests(): void {
  svgs.clear()
  chars = 0
}
