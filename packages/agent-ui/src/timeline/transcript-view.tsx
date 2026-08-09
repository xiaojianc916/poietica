import {
  type FeedRow,
  type PermissionItem,
  selectFeedRows,
  selectIsBusy,
  selectIsWaiting,
  selectTurns,
} from '@poietica/agent'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { AgentActivityFeed, type FeedPort } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { useAssistantTimeline } from '../session/use-assistant-session'
import { RestoreSpinner } from '../surface/restore-spinner'
import { ThinkingIndicator } from './thinking-indicator'
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

export interface TranscriptViewProps {
  readonly sessionKey: string
  readonly isRestoring: boolean
  /** 已经被输入框接管的那一道题：它不再进流，否则同一道题长在两个地方。 */
  readonly excluded?: PermissionItem | undefined
  readonly renderRow: (row: FeedRow) => ReactNode
}

export function TranscriptView({
  excluded,
  isRestoring,
  renderRow,
  sessionKey,
}: TranscriptViewProps) {
  const timeline = useAssistantTimeline(sessionKey)

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
   * 摘掉那一行是一次分配，所以它要有记性。
   *
   * 此前是渲染期直接 filter。而 selectTurns 的复用判据是 held.rows === rows —— 只要
   * 有一道题在等答复，visibleRows 每次渲染都是一个新数组，那张弱表就在最需要它的那
   * 段时间里恒不命中，轮次每帧重建。选择器的增量派生没有错，是上游把它的前提拆了。
   *
   * 这一层不该有第二份缓存所有权：这里 memo 的只是「摘掉一行」这次分配本身，投影
   * 仍然归选择器。
   */
  const visibleRows = useMemo(
    () => (excluded === undefined ? rows : rows.filter((row) => row.item !== excluded)),
    [excluded, rows],
  )

  /*
   * 哪几轮被人点开了。
   *
   * 只记被点开的那几轮，不记全体：默认是「落定就收起」，而一条长对话里被点开的
   * 永远是少数。按轮号记，不按行 id —— 行会随流式重建，轮号不会。
   */
  const [opened, setOpened] = useState<ReadonlySet<number>>(NOTHING_OPENED)

  const toggleTurn = useCallback((turn: number) => {
    setOpened((held) => {
      const next = new Set(held)

      if (!next.delete(turn)) {
        next.add(turn)
      }

      return next
    })
  }, [])

  /*
   * 折叠只发生在这一层。
   *
   * 领域层不知道有折叠这件事：它只记下每一轮的两端（TimelineState.spans），折哪几行
   * 是屏幕的事。所以这里是一次纯函数派生 —— 一行都不用折时原样交回入参那个数组，
   * 下游按引用比较的投影缓存不会被白打掉。
   */
  const feed = useMemo(
    () => foldFeed(visibleRows, timeline.spans, opened),
    [opened, timeline.spans, visibleRows],
  )

  /*
   * 轮次读的是屏幕上真正在滚的那个数组：摘出去一行、折起一段过程，下标都会跟着
   * 错位，而 ConversationTurn.rowIndex 正是喂给 virtualizer.scrollToIndex 的那个行号。
   */
  const turns = selectTurns(feed.rows)

  /*
   * 封条只在这里构造一次。
   *
   * 它有两个落点 —— 行的上面、转录尾部 —— 但那是同一枚封条的两个位置，不是两套实现：
   * 计划由 foldFeed 一处算出，构造也只有这一处。
   */
  const sealOf = useCallback(
    (plan: TurnSealPlan) => (
      <TurnSeal
        endedAt={plan.endedAt}
        hasProcess={plan.hasProcess}
        isOpen={plan.isOpen}
        onToggle={toggleTurn}
        startedAt={plan.startedAt}
        turn={plan.turn}
      />
    ),
    [toggleTurn],
  )

  /*
   * 封条排在它那一轮内容的前面，而不是自己占一行。
   *
   * 行的类型是领域层的投影，虚拟器的估高表与几处穷尽 switch 都按类型建；为一个纯
   * 展示的标签新增一种行，等于让三处一起认识它。所以它长在行的外面：内容已经有行
   * 时，落点就是那一轮第一行「不是人话」的那一行。
   */
  const renderRowWithSeal = useCallback(
    (row: FeedRow) => {
      const seal = feed.seals.get(row.item.id)

      if (seal === undefined) {
        return renderRow(row)
      }

      return (
        <>
          {sealOf(seal)}
          <div className="turn-seal__reveal">{renderRow(row)}</div>
        </>
      )
    },
    [feed.seals, renderRow, sealOf],
  )

  /*
   * 尾部装的是属于这一轮、而不属于其中某一条的东西：还没有行可落的那枚封条，以及
   * 等待指示器。两者各说各的事实 —— 封条说的是「这一轮已经在跑」（span 由
   * run_started 开出），指示器说的是「屏幕上没有东西在动」。此前只有后者，于是读者
   * 把原始思考链藏起来之后，一轮明明在跑，界面上没有任何东西承认它在跑。
   */
  const waiting = selectIsWaiting(timeline)

  const footer =
    feed.tail === undefined && !waiting ? undefined : (
      <>
        {feed.tail === undefined ? null : sealOf(feed.tail)}
        {waiting ? <ThinkingIndicator /> : null}
      </>
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
       * 判据里带 rows.length === 0 不是防抖，是归属：这个图标属于「空白」，
       * 不属于「忙碌」。第一批行一到就撤，不等 isRestoring 落下。
       */}
      <RestoreSpinner active={isRestoring && rows.length === 0} />

      <AgentActivityFeed
        footer={footer}
        isBusy={selectIsBusy(timeline)}
        overlay={overlay}
        renderRow={renderRowWithSeal}
        rows={feed.rows}
      />
    </>
  )
}
