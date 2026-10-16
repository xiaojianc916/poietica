import './reply-actions.css'

import { useCopy } from '@poietica/design-system'
import type { TranscriptUsage } from '@poietica/transcript'
import { Check, Copy, Split } from 'lucide-react'
import { memo, type ReactNode } from 'react'

export interface ReplyActionHostProps {
  readonly children: ReactNode
  /** null 表示此刻不能分叉（原因见 forkUnavailableReason），不是「保留 0 轮」。 */
  readonly keepTurns: number | null
  readonly forkUnavailableReason: string | null
  /** 缺席 = 按钮禁用，而不是点了没反应。 */
  readonly onFork: ((keepTurns: number) => void) | undefined
  readonly text: string
  readonly usage?: TranscriptUsage | undefined
}

/*
 * 一轮回复末端与操作行的共同悬停边界：操作行在正常文档流里占住自己那一条，显隐全部交给 CSS :hover / :focus-within。
 * 按钮本就在悬停子树内部，从正文移到按钮不会离开热区，不需要退场宽限计时器。
 */
export function ReplyActionHost({
  children,
  keepTurns,
  forkUnavailableReason,
  onFork,
  text,
  usage,
}: ReplyActionHostProps) {
  return (
    <div className="timeline-turn-end">
      {children}
      <ReplyActions
        forkUnavailableReason={forkUnavailableReason}
        onFork={onFork}
        text={text}
        keepTurns={keepTurns}
        usage={usage}
      />
    </div>
  )
}

export interface ReplyActionsProps {
  readonly keepTurns: number | null
  readonly forkUnavailableReason: string | null
  readonly onFork: ((keepTurns: number) => void) | undefined
  readonly text: string
  readonly usage?: TranscriptUsage | undefined
}

const FORK = '从这一运行分叉'

function compactCount(value: number): string {
  if (value < 1000) {
    return String(value)
  }
  const units = ['K', 'M', 'B'] as const
  let scaled = value
  let unit = -1
  do {
    scaled /= 1000
    unit += 1
  } while (scaled >= 1000 && unit < units.length - 1)
  const label = units[unit] ?? 'B'
  const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(2).replace(/\.?0+$/, '')
  return `${text}${label}`
}

function usageLabel(usage: TranscriptUsage | undefined): string | null {
  if (usage === undefined) {
    return null
  }
  let total = 0
  if (usage.inputTokens !== undefined) {
    total += usage.inputTokens
  }
  if (usage.outputTokens !== undefined) {
    total += usage.outputTokens
  }
  if (usage.cachedTokens !== undefined) {
    total += usage.cachedTokens
  }
  return total > 0 ? `${compactCount(total)} token` : null
}

function Actions({ keepTurns, forkUnavailableReason, onFork, text, usage }: ReplyActionsProps) {
  const { copied, copy } = useCopy()
  const CopyStateIcon = copied ? Check : Copy
  const unavailable =
    forkUnavailableReason ??
    (onFork === undefined ? '当前平台不提供分叉操作。' : keepTurns === null ? '这一轮还不能分叉。' : null)
  const label = unavailable === null ? FORK : `${FORK}（${unavailable}）`
  const tokens = usageLabel(usage)
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
          if (unavailable === null && keepTurns !== null) {
            onFork?.(keepTurns)
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        <Split aria-hidden="true" className="timeline-reply-actions__split-icon" />
      </button>
      {tokens === null ? null : (
        <span className="timeline-reply-actions__usage" title="这一轮 agent 上报的 token 用量">
          {tokens}
        </span>
      )}
    </div>
  )
}

export const ReplyActions = memo(Actions)
