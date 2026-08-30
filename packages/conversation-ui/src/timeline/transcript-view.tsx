import type { TurnMark } from '@poietica/conversation'
import { selectIsBusy, selectPresentation } from '@poietica/conversation'
import { type ReactNode, useCallback, useState } from 'react'
import { AgentActivityFeed, type FeedPort } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { useTranscripts } from '../session/transcripts-context'
import {
  useAssistantHasEarlier,
  useAssistantOutline,
  useAssistantTimeline,
} from '../session/use-assistant-session'
import { RestoreSpinner } from '../surface/restore-spinner'
import { estimateRowPx } from './row-estimate'
import { rowRhythmOf } from './row-rhythm'
import { TimelineSeat } from './timeline-seat'

/*
 * 转录，以及只随转录变化的那些东西。
 *
 * 它存在的理由只有一个：把「以帧率变化的订阅」关在一棵尽可能小的子树里。
 * 这里不量任何几何，也不持有领域态：滚动归虚拟器，投影归 selectPresentation。
 */

/**
 * 人亲手改过的开合，一份。
 *
 * 合成一份不是为了少一个 useState：滚动区认的是这份东西的身份 —— 换一个身份 = 这一帧
 * 的高度变化是人点出来的（AgentActivityFeedProps.disclosed）。分成两份时封条那一次改
 * 的是另一份，滚动区看不见，于是它被当成了模型在吐字，末端锚定把整屏往上拽。
 */
interface Disclosure {
  /** 哪些抽屉开着；键是条目 id。 */
  readonly items: ReadonlySet<string>
  /** 人亲手为哪几轮定过封条；键是投影交出的权威段号。 */
  readonly seals: ReadonlyMap<number, boolean>
}

/* 谁都没点过时共用同一份：状态的初值不该每次渲染换一个引用。 */
const NOTHING: Disclosure = { items: new Set(), seals: new Map() }

export interface TranscriptViewProps {
  readonly sessionKey: string
  readonly isRestoring: boolean
  /** 转录之前那一块常驻内容,交给滚动盒。 */
  readonly lead?: ReactNode
  /** 从某一轮分叉；dropTurns 是这一轮之后还有几轮。缺席 = 平台没有这个动作。 */
  readonly onFork?: ((dropTurns: number) => void) | undefined
}

export function TranscriptView({ isRestoring, lead, onFork, sessionKey }: TranscriptViewProps) {
  const timeline = useAssistantTimeline(sessionKey)
  const hasEarlier = useAssistantHasEarlier(sessionKey)
  const outline = useAssistantOutline(sessionKey)
  const transcripts = useTranscripts()

  /* 视口只报「顶端快见底了」，读不读、读几页归 store。 */
  const readEarlier = useCallback(() => {
    return transcripts.readEarlier(sessionKey)
  }, [sessionKey, transcripts])

  /*
   * 人亲手改过的开合。抽屉那一半必须长在行的外面 —— 行归虚拟器铺，滚出视口就卸载，
   * state 放在行里等于让人一滚就丢，而行高量表按 id 记，它那时还留着展开时那一测。
   *
   * 这里只记「人说了什么」，不记「现在开着还是关着」—— 后者由投影按这一轮跑不跑算出来，
   * 存第二份就会有两个真相：运行结束该自己收起的那一刻，本地那份还停在上一次的答案。
   * 折叠仍是一次状态跳变，不等任何动画事件来收尾：过程行归虚拟器管，屏幕外的那些根本
   * 没有 DOM，事件永远不会到。
   */
  const [disclosure, setDisclosure] = useState<Disclosure>(NOTHING)

  /*
   * 段号是每条对话各自从头编的，所以换一条对话必须清空 —— 否则 A 的第一轮点过的开合会
   * 落到 B 的第一轮头上。条目 id 全局唯一，那一半不清，行高量表也没清。渲染期复位是
   * React 给「props 变了要复位 state」的写法，与 assistant-surface 的相位复位同一条。
   */
  const [seen, setSeen] = useState(sessionKey)

  if (seen !== sessionKey) {
    setSeen(sessionKey)
    setDisclosure((current) => ({ items: current.items, seals: NOTHING.seals }))
  }

  const chooseTurn = useCallback((turn: number, isOpen: boolean) => {
    setDisclosure((current) => ({
      items: current.items,
      seals: new Map(current.seals).set(turn, isOpen),
    }))
  }, [])

  const toggleOpen = useCallback((id: string) => {
    setDisclosure((current) => {
      const items = new Set(current.items)

      if (!items.delete(id)) {
        items.add(id)
      }

      return { items, seals: current.seals }
    })
  }, [])

  /* 封条那一半进投影，抽屉那一半进行；整份的身份就是滚动区认的那个凭据。 */
  const { items, seals } = disclosure

  /*
   * 转录的唯一投影：折叠、并组、封条、回复操作、轮次索引一次算出，按段增量。
   *
   * 不包 useMemo：缓存的所有权在投影里 —— 那里按段记账、跨组件共享，这里的依赖每帧
   * 换引用，包了也永远不命中。
   */
  const feed = selectPresentation(timeline, seals)

  /*
   * 一行的全部装饰按下标问，交给记忆化的行位。
   *
   * 封条始终挂在该运行第一条用户消息之后；过程行的显隐不会更换它的虚拟行 key、
   * 估高类别或行内边距。
   */
  const renderRowAt = useCallback(
    (index: number) => {
      const row = feed.rowAt(index)

      if (row === undefined) {
        return null
      }

      const replyAction = feed.replyAt(index)

      return (
        <TimelineSeat
          group={feed.groupAt(index)}
          onFork={onFork}
          onSealToggle={chooseTurn}
          onToggle={toggleOpen}
          open={items}
          replyDropTurns={replyAction?.dropTurns}
          replyText={replyAction?.text}
          row={row}
          seal={feed.sealAt(index)}
        />
      )
    },
    [chooseTurn, feed, items, onFork, toggleOpen],
  )

  /* 估高、节奏与渲染同源：类别知识都在这一层，滚动窗口只收三个按下标问的函数。 */
  const estimateRowAt = useCallback((index: number) => estimateRowPx(feed.rowAt(index)), [feed])
  const rowRhythmAt = useCallback((index: number) => rowRhythmOf(feed.rowAt(index)), [feed])

  /*
   * 目录点了哪一轮。
   *
   * 地址是 admissionId：认得就直接落点，认不得就先把缺口读回来，再问一次同一个投影。
   * 行号只在这一步出现，而且是问出来的，不是存着的。
   */
  const reveal = useCallback(
    (mark: TurnMark, toRow: (row: number) => void) => {
      const rowOf = () =>
        selectPresentation(transcripts.read(sessionKey).timeline, seals).rowOf(mark.admissionId)
      const known = rowOf()

      if (known !== undefined) {
        toRow(known)

        return
      }

      void transcripts.revealTurn(sessionKey, mark).then(() => {
        const landed = rowOf()

        if (landed !== undefined) {
          toRow(landed)
        }
      })
    },
    [seals, sessionKey, transcripts],
  )

  const overlay = useCallback(
    (port: FeedPort) => (
      <ConversationMinimap
        activeId={feed.turnIdAt(port.activeRow)}
        marks={outline}
        onSelect={(mark) => {
          reveal(mark, port.scrollToRow)
        }}
      />
    ),
    [feed, outline, reveal],
  )

  return (
    <>
      {/*
       * 判据里带 count === 0 不是防抖，是归属：这个图标属于「空白」，不属于「忙碌」。
       */}
      <RestoreSpinner active={isRestoring && feed.count === 0} />

      <AgentActivityFeed
        conversation={sessionKey}
        disclosed={disclosure}
        estimateRow={estimateRowAt}
        feed={feed}
        hasEarlier={hasEarlier}
        isBusy={selectIsBusy(timeline)}
        lead={lead}
        onReachStart={readEarlier}
        overlay={overlay}
        renderRow={renderRowAt}
        rowRhythm={rowRhythmAt}
      />
    </>
  )
}
