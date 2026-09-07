import { memo } from 'react'
import type { FeedRow, ToolGroupPlan, TurnSealPlan } from '../../timeline/presentation'
import { ReplyActionHost } from './reply-actions'
import { TimelineRow } from './timeline-row'
import { ToolGroupCard } from './tool-group-card'
import { TurnSeal } from './turn-seal'

export interface TimelineSeatProps {
  readonly row: FeedRow
  readonly group: ToolGroupPlan | undefined
  readonly seal: TurnSealPlan | undefined
  readonly replyText: string | undefined
  readonly replyUndoCount: number | null | undefined
  readonly replyForkReason: string | null | undefined
  readonly open: ReadonlySet<string>
  readonly onToggle: (id: string) => void
  readonly onSealToggle: (turn: number, isOpen: boolean) => void
  readonly onFork?: ((undoCount: number) => void) | undefined
}

export const TimelineSeat = memo(function TimelineSeat({
  group,
  onFork,
  onSealToggle,
  onToggle,
  open,
  replyUndoCount,
  replyForkReason,
  replyText,
  row,
  seal,
}: TimelineSeatProps) {
  const rowOf = (one: FeedRow) => (
    <TimelineRow isOpen={open.has(one.item.id)} onToggle={onToggle} row={one} />
  )
  const content = (
    <>
      {group === undefined ? (
        rowOf(row)
      ) : (
        <ToolGroupCard
          isOpen={open.has(group.id)}
          onToggle={() => onToggle(group.id)}
          plan={group}
          renderRow={rowOf}
        />
      )}
      {seal === undefined ? null : (
        <TurnSeal
          durationMs={seal.durationMs}
          endedAt={seal.endedAt}
          hasProcess={seal.hasProcess}
          isOpen={seal.isOpen}
          isRunning={seal.isRunning}
          lastFrameAt={seal.lastFrameAt}
          onToggle={onSealToggle}
          startedAt={seal.startedAt}
          turn={seal.turn}
        />
      )}
    </>
  )
  return replyText === undefined ? (
    content
  ) : (
    <ReplyActionHost
      forkUnavailableReason={replyForkReason ?? null}
      onFork={onFork}
      text={replyText}
      undoCount={replyUndoCount ?? null}
    >
      {content}
    </ReplyActionHost>
  )
})
