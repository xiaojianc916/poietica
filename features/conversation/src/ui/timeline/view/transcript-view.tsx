import { useProseSettled } from '@poietica/design-system/prose'
import { useContributions } from '@poietica/ui-kernel'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { toolCallRenderers } from '../../../ui-api'
import type { TurnMark } from '../../shared/model/thread'
import { AgentActivityFeed, type FeedPort, type RowRhythm } from '../feed/agent-activity-feed'
import { ConversationMinimap } from '../minimap/conversation-minimap'
import { useTranscripts } from '../model/transcripts-context'
import {
  useAssistantHasEarlier,
  useAssistantOutline,
  useAssistantRevealTarget,
  useAssistantTimeline,
} from '../model/use-assistant-session'
import type { FeedRow, Presentation } from '../presentation'
import { inlineToolsOf, selectPresentation } from '../presentation'
import { selectIsBusy } from '../timeline-queries'
import { RetryTurn } from './retry-turn'
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
  /** 从某一轮重写：参数是那一轮的轮号；缺席时回复下不出现重写钮 */
  readonly onRewrite?: ((turn: number) => void) | undefined
  /** 执行 omp 的 `/retry`；缺席（命令表里没有、或正在跑）时末轮报错下不出现重试钮 */
  readonly onRetry?: (() => void) | undefined
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
  retry: 'glyph',
  tool_call: 'glyph',
  run_anchor: 'prose',
  user_message: 'prose',
}

function rowRhythmOf(row: FeedRow | undefined): RowRhythm {
  const item = row?.item

  return item === undefined ? 'prose' : RHYTHM[item.type]
}

/** 这一轮已经停下，且以报错收尾（错误级报错在末行，或自动重试用尽）：只有这时 omp 的 retry 才有东西可撤 */
function endsInError(feed: Presentation): boolean {
  const last = feed.rowAt(feed.count - 1)?.item
  if (feed.running !== undefined || last === undefined) return false
  if (last.type === 'error') return last.level !== 'warning'
  /* 重试那一行未必在末尾：后几次请求流出的半截回复接在它后面，所以在末轮里往前找 */
  for (let index = feed.count - 1; index >= 0; index -= 1) {
    const item = feed.rowAt(index)?.item
    if (item === undefined || item.turn !== last.turn) return false
    if (item.type === 'retry') return item.state === 'failed'
  }
  return false
}

/**
 * 第一次挂载压到正文排版落定之后（性能方案 P5：排版实现在独立分块里，首帧之后才预取）。行高按排版量：
 * 先按源码画一遍再换成排版，虚拟器会量到两次高度、位置跟着跳。落定通常早于转录到手（预取在入口页画完就开始），
 * 所以这一层多半不等；到不了时同样算落定，正文按源码显示。
 */
export function TranscriptView(props: TranscriptViewProps) {
  return useProseSettled() ? <SettledTranscriptView {...props} /> : null
}

function SettledTranscriptView({ dockClearance, lead, onFork, onRetry, onRewrite, sessionKey }: TranscriptViewProps) {
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

  /* 判据跟着贡献走，引用稳定，投影的缓存按它判命中。投影本身不在这里包 useMemo：依赖每帧换引用，包了也永远不命中。 */
  const renderers = useContributions(toolCallRenderers)
  const inline = useMemo(() => inlineToolsOf(renderers.map((contributed) => contributed.item)), [renderers])
  const feed = selectPresentation(timeline, seals, inline)
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
          onRewrite={onRewrite}
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
    [chooseTurn, feed, items, onFork, onRewrite, sessionKey, toggleOpen],
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
        const projection = selectPresentation(transcripts.read(sessionKey).timeline, seals, inline)
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
    [inline, outline, seals, sessionKey, transcripts],
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
        running === undefined ? (
          onRetry !== undefined && endsInError(feed) ? (
            <RetryTurn onRetry={onRetry} />
          ) : undefined
        ) : (
          <RunningStatus divided={running.divided} startedAt={running.startedAt} />
        )
      }
    />
  )
}
