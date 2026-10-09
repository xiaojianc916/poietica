import { lastAtOrBefore } from '../../timeline/ordered-lookup'

/**
 * 一行在滚动内容坐标里的起点。
 *
 * 行首尾相接完整铺满转录区、起点单调，覆盖锚点的行 = 最后一条起点不晚于锚点的行，
 * 终点参与不了判断；结构与 VirtualItem 兼容，getVirtualItems() 结果直接传入、泛型原样交回。
 */
export interface RowSpan {
  readonly index: number
  readonly start: number
}

/**
 * 锚点落在哪一行。不用视口上沿：上一轮的残留像素占住上沿，答案会归上一轮。
 * 表空返回 null（首帧无几何，谎称 0 会让缩略导航先亮第一轮再跳走）；锚点在首行
 * 之前归首行（顶部留白不属于任何一行，人读的是紧随其后的行）。交回整个区间：
 * 贴齐判断要用起点，掐掉再查第二次是把一次读取拆成两次。二分与轮次导航同一条
 * 判据，实现在 timeline/ordered-lookup。
 */
export function rowAtAnchor<Span extends RowSpan>(spans: readonly Span[], anchor: number): Span | null {
  const found = lastAtOrBefore(spans, (span) => span.start, anchor)

  return spans[found < 0 ? 0 : found] ?? null
}
