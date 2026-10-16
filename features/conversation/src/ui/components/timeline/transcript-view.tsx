import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import type { TurnMark } from '../../agent/thread'
import type { FeedRow, Presentation } from '../../timeline/presentation'
import { selectPresentation } from '../../timeline/presentation'
import { selectIsBusy } from '../../timeline/timeline-queries'
import { useTranscripts } from '../../transcript/transcripts-context'
import {
  useAssistantHasEarlier,
  useAssistantOutline,
  useAssistantRevealTarget,
  useAssistantTimeline,
} from '../../transcript/use-assistant-session'
import { AgentActivityFeed, type FeedPort, type RowRhythm } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { createRowEstimator } from './row-estimate'
import { RunningStatus } from './running-status'
import { TimelineSeat } from './timeline-seat'

const REPLY_ACTIONS_PX = 32

/** 人亲手改过的开合必须合成一份：分开存的话封条改的是另一份，滚动区看不见，会把整屏当成模型在吐字。 */
interface Disclosure {
  readonly items: ReadonlySet<string>
  readonly seals: ReadonlyMap<number, boolean>
}

const NOTHING: Disclosure = { items: new Set(), seals: new Map() }

function nearestLandingRow(
  projection: Presentation,
  outline: readonly TurnMark[],
  admissionId: string,
): number | undefined {
  const selected = outline.findIndex((candidate) => candidate.admissionId === admissionId)
  if (selected < 0) {
    return undefined
  }
  for (let distance = 1; distance < outline.length; distance += 1) {
    const earlier = outline[selected - distance]
    if (earlier !== undefined) {
      const row = projection.rowOf(earlier.admissionId)
      if (row !== undefined) {
        return row
      }
    }
    const later = outline[selected + distance]
    if (later !== undefined) {
      const row = projection.rowOf(later.admissionId)
      if (row !== undefined) {
        return row
      }
    }
  }
  return undefined
}

export interface TranscriptViewProps {
  readonly sessionKey: string
  readonly dockClearance: number | null
  readonly lead?: ReactNode
  /** 参数是要留下的轮数（= 点的那一轮的轮号）。缺席表示平台不提供分叉。 */
  readonly onFork?: ((keepTurns: number) => void) | undefined
}

// 与 row-estimate.ts 同一条约束：新增条目类型在这里编译失败。
const RHYTHM: Record<FeedRow['item']['type'], RowRhythm> = {
  agent_text: 'prose',
  agent_thought: 'glyph',
  compaction: 'glyph',
  error: 'prose',
  inflight_prompt: 'prose',
  link: 'glyph',
  permission: 'prose',
  plan: 'prose',
  question: 'prose',
  tool_call: 'glyph',
  run_anchor: 'prose',
  user_message: 'prose',
}

function rowRhythmOf(row: FeedRow | undefined): RowRhythm {
  const item = row?.item

  return item === undefined ? 'prose' : RHYTHM[item.type]
}

export function TranscriptView({ dockClearance, lead, onFork, sessionKey }: TranscriptViewProps) {
  const timeline = useAssistantTimeline(sessionKey)
  const hasEarlier = useAssistantHasEarlier(sessionKey)
  const outline = useAssistantOutline(sessionKey)
  const revealTarget = useAssistantRevealTarget(sessionKey)
  const transcripts = useTranscripts()

  const readEarlier = useCallback(() => {
    return transcripts.readEarlier(sessionKey)
  }, [sessionKey, transcripts])

  /*
   * 抽屉这一半必须长在行的外面（行滚出视口就卸载，state 放在行里人一滚就丢）。只记「人说了什么」，不记开关状态 —— 后者由投影算出，存第二份就有两个真相。
   */
  const [disclosure, setDisclosure] = useState<Disclosure>(NOTHING)

  /* 段号每条对话各自从头编，换一条必须清空，否则 A 的第一轮点过的开合会落到 B 的第一轮头上；条目 id 全局唯一，那一半不清。 */
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

  const { items, seals } = disclosure

  /* 投影里的缓存不在这里包 useMemo：依赖每帧换引用，包了也永远不命中。 */
  const feed = selectPresentation(timeline, seals)
  const estimateRow = useMemo(() => {
    void sessionKey
    return createRowEstimator()
  }, [sessionKey])

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
          replyForkReason={replyAction?.forkUnavailableReason}
          replyText={replyAction?.text}
          replyKeepTurns={replyAction?.keepTurns}
          replyUsage={replyAction?.usage}
          row={row}
          seal={feed.sealAt(index)}
          threadId={sessionKey}
        />
      )
    },
    [chooseTurn, feed, items, onFork, sessionKey, toggleOpen],
  )

  const estimateRowAt = useCallback(
    (index: number) => {
      const estimate = estimateRow(feed.rowAt(index))
      /* 高度正本在 reply-actions.css（4px 间距 + 28px 行高）。 */
      return feed.replyAt(index) === undefined ? estimate : estimate + REPLY_ACTIONS_PX
    },
    [estimateRow, feed],
  )
  const rowRhythmAt = useCallback((index: number) => rowRhythmOf(feed.rowAt(index)), [feed])

  const reveal = useCallback(
    (mark: TurnMark, toRow: (row: number) => void) => {
      const landingOf = (allowNearest: boolean): number | undefined => {
        const projection = selectPresentation(transcripts.read(sessionKey).timeline, seals)
        const exact = projection.rowOf(mark.admissionId)
        if (exact !== undefined || !allowNearest) {
          return exact
        }
        return nearestLandingRow(projection, outline, mark.admissionId)
      }

      const known = landingOf(false)
      if (known !== undefined) {
        toRow(known)
        return
      }

      void transcripts.revealTurn(sessionKey, mark).then(() => {
        const landed = landingOf(true)
        if (landed !== undefined) {
          toRow(landed)
        }
      })
    },
    [outline, seals, sessionKey, transcripts],
  )

  /* onSelect 内联等于每帧换一个函数身份，而 ConversationMinimap 是 memo 的，那一栏会跟着滚动逐帧重渲（实测 15/15 次 commit 都真重渲）。落点从 ref 读最新那份。 */
  const feedPort = useRef<FeedPort | null>(null)
  const selectMark = useCallback(
    (mark: TurnMark) => {
      const port = feedPort.current

      if (port !== null) {
        reveal(mark, port.scrollToRow)
      }
    },
    [reveal],
  )
  const overlay = useCallback(
    (port: FeedPort) => {
      feedPort.current = port

      return (
        <ConversationMinimap
          activeId={feed.turnIdAt(port.activeRow)}
          busyId={revealTarget}
          marks={outline}
          onSelect={selectMark}
        />
      )
    },
    [feed, outline, revealTarget, selectMark],
  )

  /*
   * 末尾那一行是常驻的：它每秒都在改字，交给虚拟器就会被当成内容长高。
   * 只有真在跑时才有它，所以运行态与非运行态之间节点数会变 —— 这是有意的，它就是那一轮的在场记号。
   */
  const running = feed.running

  return (
    <AgentActivityFeed
      conversation={sessionKey}
      disclosed={disclosure}
      dockClearance={dockClearance}
      estimateRow={estimateRowAt}
      feed={feed}
      hasEarlier={hasEarlier}
      isBusy={selectIsBusy(timeline)}
      lead={lead}
      onReachStart={readEarlier}
      overlay={overlay}
      renderRow={renderRowAt}
      rowRhythm={rowRhythmAt}
      trailing={
        running === undefined ? undefined : <RunningStatus divided={running.divided} startedAt={running.startedAt} />
      }
    />
  )
}
