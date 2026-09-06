import './reply-actions.css'

import { useCopy } from '@poietica/design-system'
import { Check, Copy, Split } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

/* 给从回复移向按钮的指针保留短暂宽限。 */
const REPLY_ACTION_HIDE_GRACE_MS = 500

export interface ReplyActionHostProps {
  readonly children: ReactNode
  /** 官方用户撤销锚点数；null 表示此边界不可精确分叉。 */
  readonly undoCount: number | null
  readonly forkUnavailableReason: string | null
  /** 从这一轮分叉。缺席 = 动作不可用，按钮禁用而不是点了没反应。 */
  readonly onFork: ((undoCount: number) => void) | undefined
  readonly text: string
}

/*
 * 一轮回复末端与操作工具栏的共同交互边界。
 *
 * 显示立即发生，隐藏延后发生。重新进入、移动到工具栏内部或取得键盘
 * 焦点都会取消隐藏。计时器归这个宿主所有，卸载时一定清除。
 */
export function ReplyActionHost({
  children,
  undoCount,
  forkUnavailableReason,
  onFork,
  text,
}: ReplyActionHostProps) {
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)

  const cancelScheduledHide = useCallback(() => {
    if (hideTimer.current === undefined) {
      return
    }

    window.clearTimeout(hideTimer.current)
    hideTimer.current = undefined
  }, [])

  const showActions = useCallback(() => {
    cancelScheduledHide()
    setVisible(true)
  }, [cancelScheduledHide])

  const scheduleHide = useCallback(() => {
    cancelScheduledHide()

    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined
      setVisible(false)
    }, REPLY_ACTION_HIDE_GRACE_MS)
  }, [cancelScheduledHide])

  useEffect(() => cancelScheduledHide, [cancelScheduledHide])

  return (
    <div
      className="timeline-turn-end"
      data-actions-visible={visible ? 'true' : undefined}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget

        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return
        }

        scheduleHide()
      }}
      onFocusCapture={showActions}
      onPointerEnter={showActions}
      onPointerLeave={scheduleHide}
    >
      {children}
      <ReplyActions
        forkUnavailableReason={forkUnavailableReason}
        onFork={onFork}
        text={text}
        undoCount={undoCount}
      />
    </div>
  )
}

export interface ReplyActionsProps {
  readonly undoCount: number | null
  readonly forkUnavailableReason: string | null
  readonly onFork: ((undoCount: number) => void) | undefined
  readonly text: string
}

/* 落点与能力归投影；这里仅使用原生按钮呈现操作。 */
const FORK = '从这一运行分叉'

function Actions({ undoCount, forkUnavailableReason, onFork, text }: ReplyActionsProps) {
  const { copied, copy } = useCopy()
  const CopyStateIcon = copied ? Check : Copy
  const unavailable =
    forkUnavailableReason ??
    (onFork === undefined
      ? '当前平台不提供分叉操作。'
      : undoCount === null
        ? '协议无法精确定位此边界。'
        : null)
  const label = unavailable === null ? FORK : `${FORK}（${unavailable}）`
  return (
    <div className="timeline-reply-actions">
      <button
        aria-label={copied ? '已复制' : '复制回复'}
        className="timeline-reply-actions__button"
        data-copied={copied ? 'true' : undefined}
        onClick={() => copy(text)}
        type="button"
      >
        <CopyStateIcon aria-hidden="true" />
      </button>
      <button
        aria-label={label}
        className="timeline-reply-actions__button"
        disabled={unavailable !== null}
        onClick={() => {
          if (unavailable === null && undoCount !== null) {
            onFork?.(undoCount)
          }
        }}
        title={label}
        type="button"
      >
        <Split aria-hidden="true" className="timeline-reply-actions__split-icon" />
      </button>
    </div>
  )
}

/* 已结回复的操作使用稳定原始值参与浅比较。 */
export const ReplyActions = memo(Actions)
