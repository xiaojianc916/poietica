import { type FeedRow, selectIsBusy, selectPresentation, type TurnSealPlan } from '@poietica/agent'
import { useReducedMotion } from 'motion/react'
import { type ReactNode, useCallback, useReducer } from 'react'
import { AgentActivityFeed, type FeedPort } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { useAssistantEarlier, useAssistantTimeline } from '../session/use-assistant-session'
import { RestoreSpinner } from '../surface/restore-spinner'
import { LiveProcess } from './live-process'
import { ReplyActionHost } from './reply-actions'
import { ToolGroupCard } from './tool-group-card'
import { TurnSeal } from './turn-seal'

/*
 * 转录，以及只随转录变化的那些东西。
 *
 * 它存在的理由只有一个：把「以帧率变化的订阅」关在一棵尽可能小的子树里。
 * 这里不量任何几何，也不持有领域态：滚动归虚拟器，投影归 selectPresentation。
 */

/* 没有一轮被点开时共用同一个空集：状态的初值不该每次渲染换一个引用。 */
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

const INITIAL_FOLD_UI: FoldUiState = { opened: NOTHING_OPENED, motion: NO_TURN_MOTION }

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

    return { opened, motion }
  }

  const visible = opened.has(action.turn) && motion.get(action.turn) !== 'closing'

  if (!action.animate) {
    motion.delete(action.turn)
    if (visible) {
      opened.delete(action.turn)
    } else {
      opened.add(action.turn)
    }
    return { opened, motion }
  }

  if (visible) {
    motion.set(action.turn, 'closing')
  } else {
    opened.add(action.turn)
    motion.set(action.turn, 'opening')
  }

  return { opened, motion }
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

  /* 缺席就是前面没有了：滚动区据此连报都不报。 */
  const onReachTop = useAssistantEarlier(sessionKey)

  /*
   * 哪几轮被人点开了。按轮号记，不按行 id —— 行会随流式重建，轮号不会。
   */
  const [foldUi, dispatchFoldUi] = useReducer(foldUiReducer, INITIAL_FOLD_UI)
  const animateTurn = useReducedMotion() !== true

  const toggleTurn = useCallback(
    (turn: number) => {
      dispatchFoldUi({ type: 'toggle', turn, animate: animateTurn })
    },
    [animateTurn],
  )

  const finishTurnMotion = useCallback((turn: number, motion: TurnMotion) => {
    dispatchFoldUi({ type: 'finish', turn, motion })
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
        isOpen={foldUi.motion.get(plan.turn) === 'closing' ? false : plan.isOpen}
        onToggle={toggleTurn}
        startedAt={plan.startedAt}
        turn={plan.turn}
      />
    ),
    [foldUi.motion, toggleTurn],
  )

  /* 组挂在行外面（key 是组内第一条的 id）：查得到画组，查不到照旧画这一行。 */
  const renderLiveRow = useCallback(
    (row: FeedRow) => {
      const plan = feed.liveGroupOf(row.item.id)

      return plan === undefined ? (
        renderRow(row)
      ) : (
        <ToolGroupCard plan={plan} renderRow={renderRow} />
      )
    },
    [feed, renderRow],
  )

  /*
   * 一行的全部装饰按下标问，不再逐张弱表查 id。
   * 封条挂在提问行之后，因此 DOM 顺序恒为「提问、封条、AI 内容」；开合不搬家。
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
      const motion = feed.isProcessRow(index) ? foldUi.motion.get(row.item.turn) : undefined

      return (
        <>
          <div
            className="turn-seal__reveal"
            data-turn-motion={motion}
            onAnimationEnd={
              motion === undefined
                ? undefined
                : (event) => {
                    if (event.currentTarget === event.target) {
                      finishTurnMotion(row.item.turn, motion)
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

  const footer = <LiveProcess renderRow={renderLiveRow} rows={feed.live} />
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
        footer={footer}
        isBusy={selectIsBusy(timeline)}
        onReachTop={onReachTop}
        overlay={overlay}
        renderRow={renderRowAt}
      />
    </>
  )
}
