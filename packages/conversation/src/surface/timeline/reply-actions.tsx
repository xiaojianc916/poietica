import './reply-actions.css'

import { useCopy } from '@poietica/design-system'
import { Check, Copy, Split } from 'lucide-react'
import { memo, type ReactNode } from 'react'

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
 * 一轮回复末端与操作行的共同悬停边界。
 *
 * 对标 OpenCode 桌面端（packages/session-ui/src/components/message-part.tsx 的
 * text-part-copy-wrapper）：操作行在正常文档流里占住自己那一条，显隐全部交给
 * CSS :hover / :focus-within。按钮本就在悬停子树内部，从正文移到按钮不会离开
 * 热区，不需要任何退场宽限计时器；操作行也不再绝对定位悬浮，不会盖住虚拟器
 * 铺出来的相邻行。
 */
export function ReplyActionHost({
  children,
  undoCount,
  forkUnavailableReason,
  onFork,
  text,
}: ReplyActionHostProps) {
  return (
    <div className="timeline-turn-end">
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
        onMouseDown={(event) => event.preventDefault()}
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
        onMouseDown={(event) => event.preventDefault()}
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
