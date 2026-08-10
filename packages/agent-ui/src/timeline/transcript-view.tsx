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
import { LiveProcess } from './live-process'
import { ReplyActionHost } from './reply-actions'
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
   * 是屏幕的事。一行都不用折时它原样交回入参那个数组，下游按引用比较的投影缓存不会
   * 被白打掉。
   *
   * 不包 useMemo，理由与上面那三个选择器同一条：foldFeed 自带按轮记账的投影缓存
   * （turn-fold 的 FOLDS 弱表，三个入参都没换时交还同一个对象），而这里的依赖里有每帧
   * 换引用的 visibleRows —— 再包一层永远不命中，只是每帧多一次依赖数组的分配与比较。
   * 缓存的所有权只能有一个，而它在派生里。
   */
  const feed = foldFeed(visibleRows, timeline.spans, opened)

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
      const replyAction = feed.replyActions.get(row.item.id)
      const rendered = renderRow(row)

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
          <ReplyActionHost text={replyAction.text}>{rendered}</ReplyActionHost>
        )

      if (seal === undefined) {
        return content
      }

      /* 淡入属于「刚刚折过」那一帧，不属于这一行本身。落定的轮次滚出视野再滚回来会被
         虚拟器重新挂载，那不是一次折叠，不该再淡一次；还在跑的那一轮钉在底部，不会被
         这样回收。包装层照留 —— min-inline-size 归它管，撤掉会改布局。 */
      return (
        <>
          {sealOf(seal)}
          <div
            className="turn-seal__reveal"
            data-settled={seal.endedAt === undefined ? undefined : 'true'}
          >
            {content}
          </div>
        </>
      )
    },
    [feed.replyActions, feed.seals, renderRow, sealOf],
  )

  /*
   * 尾部装的是属于这一轮、而不属于其中某一条的东西，三样，各说各的事实：还没有行可
   * 落的那枚封条说「这一轮已经在跑」（span 由 run_started 开出）；瞬态区说「此刻在
   * 做什么」；等待指示器说「屏幕上没有东西在动」。
   *
   * 瞬态区不在虚拟器的条目表内：它的内容变化只经过实测出来的 paddingEnd，碰不到任何
   * 一行的身份与实测高度。过程若走转录正文，一轮之内就必然有一次中段删除，而那次删除
   * 会改掉 count 与 getItemKey，一整屏行跟着重新落位。
   *
   * 顺序是自上而下的时间顺序：封条排在它那一轮的内容前面，正在做的事排在下面，还没
   * 有任何东西在动时最后那行「正在思考」在最底下。
   *
   * 三样都没有时这里也照样交出去，而不是交 undefined。瞬态区的退场要让最后那一帧多留
   * 一会儿，而「多留」只能发生在还挂着的那棵子树里 —— 按内容有无摘掉整个尾部，等于在
   * 退场开始的同一帧把宿主连根拔掉。空的片段不产生任何节点，尾部盒子照旧是 :empty，
   * 末端留白一分没变。
   */
  const waiting = selectIsWaiting(timeline)

  const footer = (
    <>
      {feed.tail === undefined ? null : sealOf(feed.tail)}
      <LiveProcess renderRow={renderRow} rows={feed.live} />
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
