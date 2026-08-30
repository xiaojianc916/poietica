import { CheckIcon, FailureIcon } from '../primitives/icons'
import { useCopy } from '../primitives/use-copy'

/**
 * 一次失败的运行，在它停下来的地方说一句。
 *
 * 它是一条线而不是一块卡片：报错原文属于排查现场，不属于阅读现场 —— 真正需要
 * 它的时刻，人要的是"整段拿走"，而不是"在流里反复读它"。所以中间这行是摘要，
 * 超出一行就截断，完整原文只交给剪贴板 —— 原生 tooltip 会按原文长度铺开，盖住的
 * 恰好是你要对照的那条流，所以这里不挂 title。
 */

export interface ErrorNoticeProps {
  readonly message: string
}

export function ErrorNotice({ message }: ErrorNoticeProps) {
  const { copied, copy } = useCopy(message)

  const Glyph = copied ? CheckIcon : FailureIcon

  return (
    <div className="timeline-error" data-copied={copied ? 'true' : undefined} role="alert">
      <button
        aria-label={copied ? '报错信息已复制' : '复制完整报错信息'}
        className="timeline-error__action"
        onClick={copy}
        type="button"
      >
        <Glyph aria-hidden="true" className="timeline-error__mark" />
        <span className="timeline-error__text">{message}</span>
      </button>
    </div>
  )
}
