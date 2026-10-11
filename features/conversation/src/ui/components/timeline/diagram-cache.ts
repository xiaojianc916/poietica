import type { DiagramInks } from './diagram-theme'

/*
 * 画过的图按「颜色 + 源码」留下 SVG 字符串。
 *
 * 图所在的行会被虚拟器卸载；没有这一份，滚回来时就要重跑一次布局引擎（主线程上几十到
 * 几百毫秒），而且行高先是源码面板、再变成图，虚拟器收到两次尺寸变化 —— 位置跟着跳。
 *
 * 存字符串不存节点：同一个节点不能同时挂在两处，而每张图都会被 importNode 成自己的副本。
 */
const SVG_ENTRIES = 64
const SVG_CHARS = 4_000_000

const svgs = new Map<string, string>()
let chars = 0

/*
 * 键要能把两张不同的图分开，也要让同一张图在同一个主题下命中：
 * inks 的键顺序不保证稳定（引擎交回的对象字面量会重排），所以按键排一遍再拼。
 */
export function inksKey(inks: DiagramInks): string {
  return Object.entries(inks)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slot, value]) => `${slot}=${value}`)
    .join('\u0001')
}

export function svgKey(inks: DiagramInks, code: string): string {
  return `${inksKey(inks)}\u0000${code}`
}

/** 命中即算一次使用：把它挪到最近端，淘汰时最后才轮到它。 */
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

/*
 * 上一次在这个主题下读到的颜色。
 *
 * 取色的探针要挂在真实祖先里才读得到令牌，而祖先要等节点上屏 —— 所以重挂载后的第一帧
 * 原本没有颜色，也就画不出图。按主题留一份，第一帧就有颜色。
 */
const inksByTheme = new Map<string, DiagramInks>()

export function currentTheme(): string {
  return document.documentElement.getAttribute('data-theme') ?? ''
}

export function cachedInks(theme: string): DiagramInks | undefined {
  return inksByTheme.get(theme)
}

export function keepInks(theme: string, inks: DiagramInks): void {
  inksByTheme.set(theme, inks)
}

/** 仅测试使用：模块级缓存跨用例留着，淘汰顺序就不可预期。 */
export function resetDiagramCacheForTests(): void {
  svgs.clear()
  chars = 0
  inksByTheme.clear()
}
