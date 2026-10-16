import { lastAtOrBefore } from '../ordered-lookup'

export interface RowSpan {
  readonly index: number
  readonly start: number
}

/** 锚点归哪一行。不用视口上沿：上一轮的残留像素占住上沿，答案会归上一轮。表空返回 null（谎称 0 会让缩略导航先亮第一轮再跳走）。 */
export function rowAtAnchor<Span extends RowSpan>(spans: readonly Span[], anchor: number): Span | null {
  const found = lastAtOrBefore(spans, (span) => span.start, anchor)

  return spans[found < 0 ? 0 : found] ?? null
}
