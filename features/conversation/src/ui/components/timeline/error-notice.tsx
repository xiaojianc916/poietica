import { useCopy } from '@poietica/design-system'
import { CheckIcon, FailureIcon, WarningIcon } from '../primitives/icons'

/**
 * 一次失败的运行，在它停下来的地方说一句。
 *
 * 它是一条线而不是一块卡片：报错原文属于排查现场，不属于阅读现场 —— 真正需要
 * 它的时刻，人要的是"整段拿走"，而不是"在流里反复读它"。所以中间这行是摘要，
 * 超出一行就截断，完整原文只交给剪贴板 —— 原生 tooltip 会按原文长度铺开，盖住的
 * 恰好是你要对照的那条流，所以这里不挂 title。
 *
 * warning 与 error 同一条线、同一位置，只换图标与图标颜色；warning 用 role=status，
 * 不打断读屏（R-09）。
 */

export interface ErrorNoticeProps {
  readonly message: string
  /** 缺省是 error：老调用点不传也保持原样 */
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
