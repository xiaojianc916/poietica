import type { TranscriptUsage } from '@poietica/transcript'
import { memo } from 'react'
import type { TurnChangesView } from '../../../ui-api'
import type { FeedRow, ToolGroupPlan, TurnSealPlan } from '../presentation'
import { ReplyActionHost } from './reply-actions'
import { TimelineRow } from './timeline-row'
import { ToolGroupCard } from './tools/tool-group-card'
import { TurnChangesBar } from './turn-changes'
import { TurnSeal } from './turn-seal'

export interface TimelineSeatProps {
  readonly row: FeedRow
  /** 这条时间线属于哪条线程：贡献的工具卡片要它。 */
  readonly threadId: string
  readonly group: ToolGroupPlan | undefined
  readonly seal: TurnSealPlan | undefined
  readonly replyText: string | undefined
  readonly replyKeepTurns: number | null | undefined
  readonly replyForkReason: string | null | undefined
  readonly replyUsage: TranscriptUsage | undefined
  /**
   * 这一轮的文件账；没有改动（或 review 没装）时缺席。
   *
   * 只在有回复操作行的那一行传 —— 一条没有正文的轮没有「回复下方」这个位置，
   * 账本挂在半空里读起来像另一轮的事。
   */
  readonly changes?: TurnChangesView | undefined
  readonly changesBusy?: boolean | undefined
  readonly changesOpen?: boolean | undefined
  readonly onToggleChanges?: (() => void) | undefined
  readonly onRewindTurn?: ((turn: number) => void) | undefined
  readonly open: ReadonlySet<string>
  readonly onToggle: (id: string) => void
  readonly onSealToggle: (turn: number, isOpen: boolean) => void
  readonly onFork?: ((keepTurns: number) => void) | undefined
  readonly onRewrite?: ((turn: number) => void) | undefined
}

export const TimelineSeat = memo(function TimelineSeat({
  changes,
  changesBusy,
  changesOpen,
  group,
  onFork,
  onRewrite,
  onSealToggle,
  onToggle,
  onToggleChanges,
  onRewindTurn,
  open,
  replyKeepTurns,
  replyForkReason,
  replyText,
  replyUsage,
  row,
  seal,
  threadId,
}: TimelineSeatProps) {
  const rowOf = (one: FeedRow) => (
    <TimelineRow isOpen={open.has(one.item.id)} onToggle={onToggle} row={one} threadId={threadId} />
  )
  const content = (
    <>
      {group === undefined ? (
        rowOf(row)
      ) : (
        <ToolGroupCard isOpen={open.has(group.id)} onToggle={() => onToggle(group.id)} plan={group} renderRow={rowOf} />
      )}
      {seal === undefined ? null : (
        <TurnSeal
          canCollapse={seal.canCollapse}
          durationMs={seal.durationMs}
          endedAt={seal.endedAt}
          isOpen={seal.isOpen}
          onToggle={onSealToggle}
          outcome={seal.outcome}
          startedAt={seal.startedAt}
          turn={seal.turn}
        />
      )}
    </>
  )
  /* 封条之后：这一轮答完了、改过哪些文件、要不要退回去 —— 三件事读起来是一条。 */
  const trailing =
    changes === undefined ? null : (
      <TurnChangesBar
        {...(changesBusy === undefined ? {} : { busy: changesBusy })}
        expanded={changesOpen ?? false}
        onRewind={() => onRewindTurn?.(changes.turn)}
        onToggle={() => onToggleChanges?.()}
        view={changes}
      />
    )
  return replyText === undefined ? (
    content
  ) : (
    <ReplyActionHost
      forkUnavailableReason={replyForkReason ?? null}
      onFork={onFork}
      onRewrite={onRewrite}
      text={replyText}
      keepTurns={replyKeepTurns ?? null}
      usage={replyUsage}
    >
      {content}
      {trailing}
    </ReplyActionHost>
  )
})
