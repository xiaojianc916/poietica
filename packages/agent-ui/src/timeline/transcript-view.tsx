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

/* 一轮都没被亲手指定时共用同一张空表：状态的初值不该每次渲染换一个引用。 */
const NOTHING_CHOSEN: ReadonlyMap<number, boolean> = new Map()

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
   * 人亲手为哪几轮定过开合；身份直接使用投影交出的权威段号。
   *
   * 这里只记「人说了什么」，不记「现在开着还是关着」—— 后者由投影按这一轮跑不跑算出来，
   * 存第二份就会有两个真相：运行结束该自己收起的那一刻，本地那份还停在上一次的答案。
   * 折叠仍是一次状态跳变，不等任何动画事件来收尾：过程行归虚拟器管，屏幕外的那些根本
   * 没有 DOM，事件永远不会到。
   */
  const [chosen, setChosen] = useState<ReadonlyMap<number, boolean>>(NOTHING_CHOSEN)

  /*
   * 段号是每条对话各自从头编的，所以换一条对话必须清空 —— 否则 A 的第一轮点过的开合会
   * 落到 B 的第一轮头上。渲染期复位是 React 给「props 变了要复位 state」的写法，与
   * assistant-surface 的相位复位同一条；不用 key，那会连滚动位置与实测行高一起丢掉。
   */
  const [seen, setSeen] = useState(sessionKey)

  if (seen !== sessionKey) {
    setSeen(sessionKey)
    setChosen(NOTHING_CHOSEN)
  }

  const chooseTurn = useCallback((turn: number, isOpen: boolean) => {
    setChosen((current) => new Map(current).set(turn, isOpen))
  }, [])

  /*
   * 转录的唯一投影：折叠、并组、封条、回复操作、轮次索引一次算出，按段增量。
   *
   * 不包 useMemo：缓存的所有权在投影里 —— 那里按段记账、跨组件共享，这里的依赖每帧
   * 换引用，包了也永远不命中。
   */
  const feed = selectPresentation(timeline, chosen)
  const turns = feed.turns

  const sealOf = useCallback(
    (plan: TurnSealPlan) => (
      <TurnSeal
        endedAt={plan.endedAt}
        hasProcess={plan.hasProcess}
        isOpen={plan.isOpen}
        isRunning={plan.isRunning}
        lastFrameAt={plan.lastFrameAt}
        onToggle={chooseTurn}
        startedAt={plan.startedAt}
        turn={plan.turn}
      />
    ),
    [chooseTurn],
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
