import { type FeedRow, selectFeedRows, selectIsBusy, selectTurns } from '@poietica/agent'
import { useReducedMotion } from 'motion/react'
import { type ReactNode, useCallback, useReducer } from 'react'
import { AgentActivityFeed, type FeedPort } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { useAssistantEarlier, useAssistantTimeline } from '../session/use-assistant-session'
import { RestoreSpinner } from '../surface/restore-spinner'
import { LiveProcess } from './live-process'
import { ReplyActionHost } from './reply-actions'
import { groupTools } from './tool-group'
import { ToolGroupCard } from './tool-group-card'
import { foldFeed, type TurnSealPlan } from './turn-fold'
import { TurnSeal } from './turn-seal'

/*
 * 转录，以及只随转录变化的那些东西。
 *
 * 它存在的理由只有一个：把「以帧率变化的订阅」关在一棵尽可能小的子树里。此前
 * 这几行长在 AssistantSurface 上，而那一层还挂着输入框、开场白与快捷入口 ——
 * 于是模型每吐一个字，一棵与转录无关的树跟着 reconcile 一次。
 *
 * 这里不量任何几何，也不持有任何状态：滚动归虚拟器，答复归上层。
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
   * 不包 useMemo。
   *
   * 这三个选择器自带投影缓存（timeline-selectors 的 FEEDS / TURNS 弱表，内容
   * 没变时交还同一个数组）。再包一层 useMemo，依赖是每帧换引用的 timeline ——
   * 那一层永远不命中，只是每帧多一次依赖数组的分配与比较。缓存的所有权只能
   * 有一个，而它在选择器里：那里是跨组件共享的位置，这里不是。
   */
  const rows = selectFeedRows(timeline)

  /*
   * 哪几轮被人点开了。
   *
   * 只记被点开的那几轮，不记全体：默认是「落定就收起」，而一条长对话里被点开的
   * 永远是少数。按轮号记，不按行 id —— 行会随流式重建，轮号不会。
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
   * 折叠只发生在这一层。
   *
   * 领域层不知道有折叠这件事：它只记下每一轮的两端（TimelineState.spans），折哪几行
   * 是屏幕的事。一行都不用折时它原样交回入参那个数组，下游按引用比较的投影缓存不会
   * 被白打掉。
   *
   * 不包 useMemo，理由与上面那三个选择器同一条：foldFeed 自带按轮记账的投影缓存
   * （turn-fold 的 FOLDS 弱表，三个入参都没换时交还同一个对象），而这里的依赖里有每帧
   * 换引用的 rows —— 再包一层永远不命中，只是每帧多一次依赖数组的分配与比较。
   * 缓存的所有权只能有一个，而它在派生里。
   */
  const feed = foldFeed(rows, timeline.spans, foldUi.opened)

  /* 此刻的最后一轮：帧流按时间排，最后一行属于谁，谁就是最后一轮。 */
  const lastTurn = rows[rows.length - 1]?.item.turn

  /*
   * 聚合排在折叠之后，两条通道各过一遍同一个函数。
   *
   * 折叠管的是「一整轮的过程收不收起」，聚合管的是「相邻的同类调用并不并」——
   * 两件事各自成立，所以是两次派生，不是一次。转录与瞬态区因此长同一个样子。
   *
   * 不包 useMemo：groupTools 自带按 rows[0] 记账的投影缓存，一组都没并时原样交回入参
   * 那个数组。再包一层的依赖里有每帧换引用的 feed.rows —— 永远不命中，只是每帧多一次
   * 依赖数组的分配与比较。缓存的所有权只能有一个，而它在派生里。
   */
  const grouped = groupTools(feed.rows)
  const groupedLive = groupTools(feed.live)

  /*
   * 轮次读的是屏幕上真正在滚的那个数组：摘出去一行、折起一段过程、并掉几条调用，下标
   * 都会跟着错位，而 ConversationTurn.rowIndex 正是喂给 virtualizer.scrollToIndex 的那个
   * 行号。所以这里读的是聚合之后的那一份，不是 feed.rows。
   */
  const turns = selectTurns(grouped.rows)

  /*
   * 封条只在这里构造一次。
   *
   * 计划由 foldFeed 一处算出，构造也只有这一处。它挂在这一轮的提问那一行上
   * （renderRowWithSeal 里的 seals 查表），不占一行，也不进转录尾部。
   */
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

  /*
   * 封条排在它那一轮内容的前面，而不是自己占一行。
   *
   * 行的类型是领域层的投影，虚拟器的估高表与几处穷尽 switch 都按类型建；为一个纯
   * 展示的标签新增一种行，等于让三处一起认识它。所以它长在行的外面：挂在这一轮的提
   * 问上，渲染在提问之后 —— 那一行开合都在，落点因此恒定。
   */
  /*
   * 瞬态区那一份。
   *
   * 组挂在行外面（key 是组内第一条的 id），所以这里的判断与封条那一处同一个形状：
   * 查得到就画组，查不到就照旧画这一行。成员仍旧交给 renderRow —— 组不改成员的样子。
   */
  const renderLiveRow = useCallback(
    (row: FeedRow) => {
      const plan = groupedLive.groups.get(row.item.id)

      return plan === undefined ? (
        renderRow(row)
      ) : (
        <ToolGroupCard plan={plan} renderRow={renderRow} />
      )
    },
    [groupedLive.groups, renderRow],
  )

  const renderRowWithSeal = useCallback(
    (row: FeedRow) => {
      const seal = feed.seals.get(row.item.id)
      const replyAction = feed.replyActions.get(row.item.id)
      const plan = grouped.groups.get(row.item.id)
      const rendered =
        plan === undefined ? renderRow(row) : <ToolGroupCard plan={plan} renderRow={renderRow} />

      /*
       * 回复操作属于整轮，不属于某一条 agent_text。
       *
       * foldFeed 已经把它的 key 放在这一轮最后一个可见条目上，因此这里不推断轮次、
       * 不检查条目类型，只负责把操作区挂到经过证明的唯一落点。
       */
      const content =
        replyAction === undefined ? (
          rendered
        ) : (
          <ReplyActionHost
            isFinal={row.item.turn === lastTurn}
            onFork={row.item.turn === lastTurn ? onFork : undefined}
            text={replyAction.text}
          >
            {rendered}
          </ReplyActionHost>
        )

      /*
       * 形状恒定：有没有封条，交出去的都是同一棵树。
       *
       * 封条缺席时交 null。一个 null 孩子不产生任何节点，包装层与它里面的正文因此在
       * 开合前后是同一批实例，一次重建都没有。
       *
       * 封条排在 content 之后，因为它挂的是这一轮的提问（turn-fold 的 saidIn）。DOM
       * 顺序仍是「提问、封条、内容」，而落点从此不随开合改变：按钮不搬家，两行的实测
       * 高度也不再作废。
       */
      const motion = feed.processRows.has(row.item.id)
        ? foldUi.motion.get(row.item.turn)
        : undefined

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
    [
      feed.processRows,
      feed.replyActions,
      feed.seals,
      finishTurnMotion,
      foldUi.motion,
      grouped.groups,
      lastTurn,
      onFork,
      renderRow,
      sealOf,
    ],
  )

  /* Live process rows are the single execution-progress surface. */
  const footer = <LiveProcess renderRow={renderLiveRow} rows={groupedLive.rows} />
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
       * 判据里带 rows.length === 0 不是防抖，是归属：这个图标属于「空白」，
       * 不属于「忙碌」。第一批行一到就撤，不等 isRestoring 落下。
       */}
      <RestoreSpinner active={isRestoring && rows.length === 0} />

      <AgentActivityFeed
        conversation={sessionKey}
        footer={footer}
        isBusy={selectIsBusy(timeline)}
        onReachTop={onReachTop}
        overlay={overlay}
        renderRow={renderRowWithSeal}
        rows={grouped.rows}
      />
    </>
  )
}
