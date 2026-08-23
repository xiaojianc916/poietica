import { lastAtOrBefore } from '../threads/ordered-lookup'

/**
 * 一行在滚动内容坐标里的起点。
 *
 * 只有起点，没有终点：行首尾相接、完整铺满转录区，所以起点单调递增且中间没有
 * 空隙 —— 「最后一个起点不晚于锚点的行」就是覆盖锚点的那一行，终点参与不了这
 * 个判断。声明一个从不被读的必填字段，只会让实现者以为它有意义。
 *
 * 结构上与虚拟器的 VirtualItem 兼容，所以调用方直接把 getVirtualItems() 的结果
 * 传进来即可，不需要映射；泛型让那一项原样交回 —— 它比这里声明的多一个身份，而
 * 认人是调用方的事，不是这条判据的事。
 */
export interface RowSpan {
  readonly index: number
  readonly start: number
}

/**
 * 锚点落在哪一行。
 *
 * 这是「人在读哪一行」的全部定义：一条视线，和它此刻穿过的那一行。不问哪一行
 * 碰到了视口上沿 —— 上沿是一条边，上一轮的残留占住它一个像素，答案就归了上一轮。
 *
 * 表为空时返回 null，而不是谎称第 0 行：首帧还没有几何可读，谎称 0 会让缩略导航
 * 先亮第一轮再跳走。锚点落在第一行之前时归第一行：视口顶部的留白不属于任何一行，
 * 但人此刻在读的显然是紧随其后的那一行。
 *
 * 交回整个区间而不只是行号：了结一次跳转除了「顶行是谁」还要问「贴齐了没有」，
 * 后者要用起点。答案本来就是查表查出来的那一项，掐掉起点再让调用方查第二次，
 * 是把一次读取拆成两次。
 *
 * 二分本身不在这里 —— 它与轮次导航用的是同一条判据，实现在 ordered-lookup。
 */
export function rowAtAnchor<Span extends RowSpan>(
  spans: readonly Span[],
  anchor: number,
): Span | null {
  const found = lastAtOrBefore(spans, (span) => span.start, anchor)

  return spans[found < 0 ? 0 : found] ?? null
}
