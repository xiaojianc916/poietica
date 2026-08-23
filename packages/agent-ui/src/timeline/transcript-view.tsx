import { type FeedRow, selectIsBusy, selectPresentation, type TurnSealPlan } from '@poietica/agent'
import { useReducedMotion } from 'motion/react'
import { type ReactNode, useCallback, useReducer } from 'react'
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

/* 一个都没点开时共用同一个空集：状态的初值不该每次渲染换一个引用。 */
const NOTHING_OPENED: ReadonlySet<number> = new Set()
const NO_TURN_MOTION: ReadonlyMap<number, TurnMotion> = new Map()

type TurnMotion = 'opening' | 'closing'

type FoldUiState = {
  readonly opened: ReadonlySet<number>
  readonly motion: ReadonlyMap<number, TurnMotion>
}

type FoldUiAction =
  | { readonly type: 'toggle'; readonly turn: number; readonly animate: boolean }
  | { readonly type: 'finish'; readonly turn: number; readonly motion: TurnMotion }

const INITIAL_FOLD_UI: FoldUiState = { motion: NO_TURN_MOTION, opened: NOTHING_OPENED }

function foldUiReducer(state: FoldUiState, action: FoldUiAction): FoldUiState {
  const opened = new Set(state.opened)
  const motion = new Map(state.motion)

  if (action.type === 'finish') {
    if (motion.get(action.turn) !== action.motion) {
      return state
    }

    motion.delete(action.turn)
    if (action.motion === 'closing') {
      opened.delete(action.turn)
    }

    return { motion, opened }
  }

  const visible = opened.has(action.turn) && motion.get(action.turn) !== 'closing'

  if (!action.animate) {
    motion.delete(action.turn)
    if (visible) {
      opened.delete(action.turn)
    } else {
      opened.add(action.turn)
    }

    return { motion, opened }
  }

  if (visible) {
    motion.set(action.turn, 'closing')
  } else {
    opened.add(action.turn)
    motion.set(action.turn, 'opening')
  }

  return { motion, opened }
}

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

  /* 哪些运行被点开了；身份直接使用投影交出的权威段号。 */
  const [foldUi, dispatchFoldUi] = useReducer(foldUiReducer, INITIAL_FOLD_UI)
  const animateTurn = useReducedMotion() !== true

  const toggleTurn = useCallback(
    (turn: number) => {
      dispatchFoldUi({ animate: animateTurn, turn, type: 'toggle' })
    },
    [animateTurn],
  )

  const finishTurnMotion = useCallback((turn: number, motion: TurnMotion) => {
    dispatchFoldUi({ motion, turn, type: 'finish' })
  }, [])

  /*
   * 转录的唯一投影：折叠、并组、封条、回复操作、轮次索引一次算出，按段增量。
   *
   * 不包 useMemo：缓存的所有权在投影里 —— 那里按段记账、跨组件共享，这里的依赖每帧
   * 换引用，包了也永远不命中。
   */
  const feed = selectPresentation(timeline, foldUi.opened)
  const turns = feed.turns

  const sealOf = useCallback(
    (plan: TurnSealPlan) => (
      <TurnSeal
        endedAt={plan.endedAt}
        hasProcess={plan.hasProcess}
        isLive={plan.isLive}
        isOpen={foldUi.motion.get(plan.turn) === 'closing' ? false : plan.isOpen}
        lastFrameAt={plan.lastFrameAt}
        onToggle={toggleTurn}
        startedAt={plan.startedAt}
        turn={plan.turn}
      />
    ),
    [foldUi.motion, toggleTurn],
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
      const owner = feed.processOf(index)
      const motion = owner === undefined ? undefined : foldUi.motion.get(owner)

      return (
        <>
          <div
            className="turn-seal__reveal"
            data-turn-motion={motion}
            onAnimationEnd={
              owner === undefined || motion === undefined
                ? undefined
                : (event) => {
                    if (event.currentTarget === event.target) {
                      finishTurnMotion(owner, motion)
                    }
                  }
            }
          >
            {content}
          </div>
          {seal === undefined ? null : sealOf(seal)}
        </>
      )
    },
    [feed, finishTurnMotion, foldUi.motion, onFork, renderRow, sealOf],
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
