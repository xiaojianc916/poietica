import './reply-actions.css'

import { useCopy } from '@poietica/design-system'
import type { TranscriptUsage } from '@poietica/transcript'
import { Check, Copy, PenLine, Split } from 'lucide-react'
import { memo, type ReactNode } from 'react'

export interface ReplyActionHostProps {
  readonly children: ReactNode
  /** null 表示此刻不能分叉（原因见 forkUnavailableReason），不是「保留 0 轮」。 */
  readonly keepTurns: number | null
  readonly forkUnavailableReason: string | null
  /** 缺席 = 按钮禁用，而不是点了没反应。 */
  readonly onFork: ((keepTurns: number) => void) | undefined
  /** 从这一轮重写（omp `/branch` 的语义）：参数是这一轮的轮号；缺席 = 按钮不画 */
  readonly onRewrite?: ((turn: number) => void) | undefined
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
  onRewrite,
  text,
  usage,
}: ReplyActionHostProps) {
  return (
    <div className="timeline-turn-end">
      {children}
      <ReplyActions
        forkUnavailableReason={forkUnavailableReason}
        onFork={onFork}
        onRewrite={onRewrite}
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
  readonly onRewrite?: ((turn: number) => void) | undefined
  readonly text: string
  readonly usage?: TranscriptUsage | undefined
}

const FORK = '从这一运行分叉'
const REWRITE = '从这一轮重写'

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

/* 分叉与重写共用一套可用性：同一个轮号、同一条「这一轮收口了没有」。 */
function TurnActionButton({
  action,
  children,
  name,
  turn,
  unavailable,
}: {
  readonly action: ((turn: number) => void) | undefined
  readonly children: ReactNode
  readonly name: string
  readonly turn: number | null
  readonly unavailable: string | null
}) {
  return (
    <button
      aria-label={unavailable === null ? name : `${name}（${unavailable}）`}
      className="timeline-reply-actions__button"
      disabled={unavailable !== null}
      onClick={() => {
        if (unavailable === null && turn !== null) {
          action?.(turn)
        }
      }}
      onMouseDown={(event) => event.preventDefault()}
      type="button"
    >
      {children}
    </button>
  )
}

function Actions({ keepTurns, forkUnavailableReason, onFork, onRewrite, text, usage }: ReplyActionsProps) {
  const { copied, copy } = useCopy()
  const CopyStateIcon = copied ? Check : Copy
  const unsettled = forkUnavailableReason ?? (keepTurns === null ? '这一轮还不能分叉。' : null)
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
      <TurnActionButton
        action={onFork}
        name={FORK}
        turn={keepTurns}
        unavailable={onFork === undefined ? '当前平台不提供分叉操作。' : unsettled}
      >
        <Split aria-hidden="true" className="timeline-reply-actions__split-icon" />
      </TurnActionButton>
      {/* 重写 = 留下这一轮之前的历史另开一条，并把这一轮那句话放回输入框：与 omp `/branch` 同一个动作，原对话不动 */}
      {onRewrite === undefined ? null : (
        <TurnActionButton action={onRewrite} name={REWRITE} turn={keepTurns} unavailable={unsettled}>
          <PenLine aria-hidden="true" />
        </TurnActionButton>
      )}
      {tokens === null ? null : (
        <span className="timeline-reply-actions__usage" title="这一轮 agent 上报的 token 用量">
          {tokens}
        </span>
      )}
    </div>
  )
}

export const ReplyActions = memo(Actions)
