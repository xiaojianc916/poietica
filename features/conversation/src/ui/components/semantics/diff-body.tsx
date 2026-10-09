import type { ReactElement, RefObject } from 'react'
import type { DiffFile } from './review-port'

/*
 * 抽屉里的那一段行带。
 *
 * legacy 用的是 @poietica/review/surface 的 DiffBody（带折叠、按文件分组、着色、横向出口）。
 * P5 保留「一副行模型画成行」这一件事与**同一个 props 形状**（file/gaps/scroller/scrollX/wrap），
 * 类名沿用 conversation 自己的 \`.timeline-tool__diff\`（tool-call.css 里本来就有）；
 * P6 的 review 经 toolCallRenderers 贡献真正的行带时，这一层随之退成兜底。
 */

export interface DiffBodyProps {
  readonly file: DiffFile
  /** 折叠带要不要画。这一处改动只取三行上下文，跳过的行没进模型，所以调用方给 false */
  readonly gaps?: boolean | undefined
  readonly scroller?: RefObject<HTMLElement | null> | undefined
  readonly scrollX?: boolean | undefined
  readonly wrap?: boolean | undefined
}

export function DiffBody({ file, gaps = true }: DiffBodyProps): ReactElement {
  return (
    <div className="timeline-tool__diff-body" data-gaps={gaps ? 'true' : undefined}>
      {file.rows.map((row) => (
        <div className="timeline-tool__diff-row" data-kind={row.kind} key={row.at}>
          <span className="timeline-tool__diff-number">{row.number ?? ''}</span>
          <span className="timeline-tool__diff-text">{row.text}</span>
        </div>
      ))}
    </div>
  )
}
