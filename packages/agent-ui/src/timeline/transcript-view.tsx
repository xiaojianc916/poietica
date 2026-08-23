import { type FeedRow, selectIsBusy, selectPresentation, type TurnSealPlan } from '@poietica/agent'
import { type ReactNode, useCallback, useState } from 'react'
import { AgentActivityFeed, type FeedPort } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { useAssistantTimeline } from '../session/use-assistant-session'
import { RestoreSpinner } from '../surface/restore-spinner'
import { ReplyActionHost } from './reply-actions'
import { ToolGroupCard } from './tool-group-card'
import { TurnSeal } from './turn-seal'

/*
 * 转录，以及只随转录变化的那些东西。
 *
 * 它存在的理由只有一个：把「以帧率变化的订阅」关在一棵尽可能小的子树里。
 * 这里不量任何几何，也不持有领域态：滚动归虚拟器，投影归 selectPresentation。
 */

/* 一轮都没收起时共用同一个空集：状态的初值不该每次渲染换一个引用。 */
const NOTHING_FOLDED: ReadonlySet<number> = new Set()

export interface TranscriptViewProps {
  readonly sessionKey: string
  readonly isRestoring: boolean
  readonly renderRow: (row: FeedRow) => ReactNode
  /**
   * 分叉这条对话（整条带走）。ACP 的 session/fork 没有分叉点，所以它只交给
   * 最后一轮 —— 从最后一轮分叉恰好就是整条。缺席 = 平台没有这个动作。
   */
  readonly onFork?: (() => void) | undefined
}

export function TranscriptView({
  isRestoring,
  onFork,
  renderRow,
  sessionKey,
}: TranscriptViewProps) {
  const timeline = useAssistantTimeline(sessionKey)

  /*
   * 人收起了哪几轮；身份直接使用投影交出的权威段号。
   *
   * 过程默认摊开，收起是一次显式指令 —— 折叠因此是一次状态跳变，不等任何动画事件
   * 来收尾：过程行归虚拟器管，屏幕外的那些根本没有 DOM，事件永远不会到。
   */
  const [folded, setFolded] = useState<ReadonlySet<number>>(NOTHING_FOLDED)

  const toggleTurn = useCallback((turn: number) => {
    setFolded((current) => {
      const next = new Set(current)

      if (!next.delete(turn)) {
        next.add(turn)
      }

      return next
    })
  }, [])

  /*
   * 转录的唯一投影：折叠、并组、封条、回复操作、轮次索引一次算出，按段增量。
   *
   * 不包 useMemo：缓存的所有权在投影里 —— 那里按段记账、跨组件共享，这里的依赖每帧
   * 换引用，包了也永远不命中。
   */
  const feed = selectPresentation(timeline, folded)
  const turns = feed.turns

  const sealOf = useCallback(
    (plan: TurnSealPlan) => (
      <TurnSeal
        endedAt={plan.endedAt}
        hasProcess={plan.hasProcess}
        isLive={plan.isLive}
        isOpen={plan.isOpen}
        lastFrameAt={plan.lastFrameAt}
        onToggle={toggleTurn}
        startedAt={plan.startedAt}
        turn={plan.turn}
      />
    ),
    [toggleTurn],
  )

  /*
   * 一行的全部装饰按下标问。封条始终挂在该运行第一条用户消息之后；过程行的显隐
   * 不会更换它的虚拟行 key、估高类别或行内边距。
   */
  const renderRowAt = useCallback(
    (index: number) => {
      const row = feed.rowAt(index)

      if (row === undefined) {
        return null
      }

      const plan = feed.groupAt(index)
      const replyAction = feed.replyAt(index)
      const seal = feed.sealAt(index)
      const isFinal = row.item.turn === feed.lastTurn
      const rendered =
        plan === undefined ? renderRow(row) : <ToolGroupCard plan={plan} renderRow={renderRow} />
      const content =
        replyAction === undefined ? (
          rendered
        ) : (
          <ReplyActionHost
            isFinal={isFinal}
            onFork={isFinal ? onFork : undefined}
            text={replyAction.text}
          >
            {rendered}
          </ReplyActionHost>
        )

      return (
        <>
          {content}
          {seal === undefined ? null : sealOf(seal)}
        </>
      )
    },
    [feed, onFork, renderRow, sealOf],
  )

  const overlay = useCallback(
    (port: FeedPort) =>
      turns.length === 0 ? null : (
        <ConversationMinimap activeRow={port.activeRow} onSelect={port.scrollToRow} turns={turns} />
      ),
    [turns],
  )

  return (
    <>
      {/*
       * 判据里带 count === 0 不是防抖，是归属：这个图标属于「空白」，不属于「忙碌」。
       */}
      <RestoreSpinner active={isRestoring && feed.count === 0} />

      <AgentActivityFeed
        conversation={sessionKey}
        feed={feed}
        isBusy={selectIsBusy(timeline)}
        overlay={overlay}
        renderRow={renderRowAt}
      />
    </>
  )
}
