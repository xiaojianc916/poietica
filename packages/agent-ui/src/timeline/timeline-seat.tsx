import type { FeedRow, ToolGroupPlan, TurnSealPlan } from '@poietica/agent'
import { memo } from 'react'
import { ReplyActionHost } from './reply-actions'
import { TimelineRow } from './timeline-row'
import { ToolGroupCard } from './tool-group-card'
import { TurnSeal } from './turn-seal'

/*
 * 一行连同它的装饰。
 *
 * memo 的全部意义在入参：行与两份计划由投影按段缓存、开合表与回调由转录那一层
 * 持有，所以模型吐字只重渲它改动的那一行，其余的行止步于一次浅比较。
 *
 * 回复操作拆成两个原始值收下 —— 投影每次都新建那个计划对象，收对象等于每帧都比不中。
 */
export interface TimelineSeatProps {
  readonly row: FeedRow
  readonly group: ToolGroupPlan | undefined
  readonly seal: TurnSealPlan | undefined
  readonly replyText: string | undefined
  readonly replyDropTurns: number | undefined
  /** 哪些抽屉开着；键是条目 id 与组 id。 */
  readonly open: ReadonlySet<string>
  readonly onToggle: (id: string) => void
  readonly onSealToggle: (turn: number, isOpen: boolean) => void
  readonly onFork?: ((dropTurns: number) => void) | undefined
}

export const TimelineSeat = memo(function TimelineSeat({
  group,
  onFork,
  onSealToggle,
  onToggle,
  open,
  replyDropTurns,
  replyText,
  row,
  seal,
}: TimelineSeatProps) {
  const rowOf = (one: FeedRow) => (
    <TimelineRow isOpen={open.has(one.item.id)} onToggle={onToggle} row={one} />
  )

  const rendered =
    group === undefined ? (
      rowOf(row)
    ) : (
      <ToolGroupCard
        isOpen={open.has(group.id)}
        onToggle={() => {
          onToggle(group.id)
        }}
        plan={group}
        renderRow={rowOf}
      />
    )

  const content =
    replyDropTurns === undefined || replyText === undefined ? (
      rendered
    ) : (
      <ReplyActionHost dropTurns={replyDropTurns} onFork={onFork} text={replyText}>
        {rendered}
      </ReplyActionHost>
    )

  return (
    <>
      {content}
      {seal === undefined ? null : (
        <TurnSeal
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
})
