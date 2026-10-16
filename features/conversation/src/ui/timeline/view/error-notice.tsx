import { useCopy } from '@poietica/design-system'
import { CheckIcon, FailureIcon, WarningIcon } from '../../shared/primitives/icons'

import './error-notice.css'

/**
 * 摘要一行、超出即截断，完整原文只交给剪贴板（原生 tooltip 会铺开盖住要对照的流，故不挂 title）；
 * warning 与 error 同线同位，只换图标与颜色，用 role=status 不打断读屏（R-09）。
 */

export interface ErrorNoticeProps {
  readonly message: string
  readonly level?: 'error' | 'warning'
}

export function ErrorNotice({ level = 'error', message }: ErrorNoticeProps) {
  const { copied, copy } = useCopy()
  const warning = level === 'warning'
  const Glyph = copied ? CheckIcon : warning ? WarningIcon : FailureIcon
  const noun = warning ? '提示' : '报错'

  return (
    <div
      className="timeline-error"
      data-copied={copied ? 'true' : undefined}
      data-level={level}
      role={warning ? 'status' : 'alert'}
    >
      <button
        aria-label={copied ? `${noun}信息已复制` : `复制完整${noun}信息`}
        className="timeline-error__action"
        onClick={() => copy(message)}
        type="button"
      >
        <Glyph aria-hidden="true" className="timeline-error__mark" />
        <span className="timeline-error__text">{message}</span>
      </button>
    </div>
  )
}
