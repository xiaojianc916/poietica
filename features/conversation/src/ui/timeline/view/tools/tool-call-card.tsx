import '../flow-row.css'
import '../ticker/shimmer.css'
import './tool-call.css'
import './tool-group.css'

import type { ToolGlyph } from '@poietica/conversation-kit/model'
import {
  AgentFace,
  agentColor,
  BrainIcon,
  BugIcon,
  ChevronDownIcon,
  ClockIcon,
  ComputerIcon,
  DeviceIcon,
  DisclosureBody,
  FileIcon,
  GlobeIcon,
  GoalIcon,
  ImageIcon,
  LearningIcon,
  LspIcon,
  MicIcon,
  ModelIcon,
  PencilIcon,
  PlanIcon,
  PluginIcon,
  QuestionIcon,
  SearchIcon,
  SkillIcon,
  TerminalIcon,
  ToolIcon,
  WandIcon,
  YieldIcon,
} from '@poietica/conversation-kit/primitives'
import { toDiffFilesOf } from '@poietica/conversation-kit/semantics'
import type { ToolCallTimelineItem } from '@poietica/conversation-kit/timeline'
import { readToolLine, toolGlyphOf } from '@poietica/conversation-kit/tools'
import { cn, GithubMark } from '@poietica/design-system'
import { type DiffStat, diffStatOf } from '@poietica/design-system/diff'
import type { ComponentType } from 'react'
import { isDelegation } from '../../delegate-channel'
import { type DelegateRow, delegateRowsOf } from '../../delegate-rows'
import { useAssistantSubagents } from '../../model/use-assistant-session'
import { useDelegateChannel } from '../delegate-channel-context'
import { ToolCallPanels } from './tool-call-panels'

/*
 * 字形只有这一处分发。名字认得出就按名字给，认不出才是「从外面来的工具」。
 *
 * GithubMark 是设计系统的品牌标记：实心、没有描边概念，与其余描边字形不是一类东西；
 * 它仍占表里一格，只是这一格的值是品牌标记而不是描边图标。
 */
const GLYPH_ICONS = {
  bug: BugIcon,
  clock: ClockIcon,
  code: LspIcon,
  computer: ComputerIcon,
  delegate: ModelIcon,
  device: DeviceIcon,
  execute: TerminalIcon,
  fetch: GlobeIcon,
  github: GithubMark,
  goal: GoalIcon,
  image: ImageIcon,
  learning: LearningIcon,
  memory: BrainIcon,
  other: ToolIcon,
  plugin: PluginIcon,
  question: QuestionIcon,
  read: FileIcon,
  search: SearchIcon,
  skill: SkillIcon,
  speech: MicIcon,
  todo: PlanIcon,
  wand: WandIcon,
  write: PencilIcon,
  yield: YieldIcon,
} satisfies Record<ToolGlyph, ComponentType<{ readonly 'aria-hidden'?: boolean; readonly className?: string }>>

export function ToolGlyphIcon({ name, scheme = '' }: { readonly name: string; readonly scheme?: string }) {
  const Icon = GLYPH_ICONS[toolGlyphOf(name, scheme)]
  return <Icon aria-hidden className="timeline-row__icon" />
}

interface ToolCallCardView {
  readonly diffStat: DiffStat | null
  readonly line: string
  readonly isRunning: boolean
}

// isRunning 两条件缺一不可：轮次还在飞，且调用没收到终态。
// status 是 agent 说过的话，没等到终态的调用会永远停在 in_progress。
function describeToolCall(item: ToolCallTimelineItem, isInFlight: boolean): ToolCallCardView {
  return {
    diffStat: diffStatOf(toDiffFilesOf(item)),
    isRunning: isInFlight && (item.status === 'pending' || item.status === 'in_progress'),
    line: readToolLine(item),
  }
}

export function ToolCallDiffStat({ diffStat }: { readonly diffStat: DiffStat | null }) {
  if (diffStat === null || diffStat.added + diffStat.removed === 0) {
    return null
  }

  return (
    <span className="timeline-tool__diffstat">
      {diffStat.added > 0 ? <span className="timeline-tool__diffstat-added">+{diffStat.added}</span> : null}
      {diffStat.removed > 0 ? <span className="timeline-tool__diffstat-removed">-{diffStat.removed}</span> : null}
    </span>
  )
}

function ToolCallHeader({
  isOpen,
  item,
  onToggle,
  view,
}: {
  readonly isOpen: boolean
  readonly item: ToolCallTimelineItem
  readonly onToggle: () => void
  readonly view: ToolCallCardView
}) {
  const { diffStat, isRunning, line } = view

  return (
    <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
      <ToolGlyphIcon name={item.invokedTool} scheme={item.scheme} />

      <span className={cn('timeline-row__label', isRunning && 'timeline-shimmer')}>{line}</span>

      {item.isBackground === true ? <span className="timeline-tool__background">后台</span> : null}

      <ToolCallDiffStat diffStat={diffStat} />

      <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
    </button>
  )
}

/**
 * 派发行的画法：一个子代理一行，照 ZCode 的 Agent 摘要行（renderers/agent.tsx + ToolSummaryRow）——
 * 脸是身份，类型名取身份色，后面跟着那次派发的描述（次级墨），整行可点、点开右坞那条通道。
 * 没有工具名、没有状态词、也不再有「N 个子代理」那一层：运行与完成由脸的动效与勾角标说。
 *
 * 取色与名字两条都从 delegate-rows 的纯函数来；脸本身是 conversation-kit 的原语（与坞标签同一张）。
 */
function DelegateLine({ row, onOpen }: { readonly row: DelegateRow; readonly onOpen?: (() => void) | undefined }) {
  const body = (
    <>
      <AgentFace
        className="timeline-delegate__face"
        name={row.type}
        showCompletionMark={row.status === 'done'}
        status={row.status}
      />

      <span className="timeline-delegate__type" style={{ color: agentColor(undefined, row.type) }}>
        {row.type}
      </span>

      <span className="timeline-delegate__said">{row.description}</span>
    </>
  )

  /* 引擎还没报出地址的那一行（刚派出去、或老会话没这个字段）：画法一样，只是它不是入口，
   * 所以既不是按钮、也没有悬停反馈 —— 不给一个点了没反应的东西。 */
  if (onOpen === undefined) {
    return <div className="timeline-row timeline-delegate">{body}</div>
  }

  return (
    <button className="timeline-row timeline-delegate" onClick={onOpen} title={row.description} type="button">
      {body}
    </button>
  )
}

function DelegateRows({ item, threadId }: { readonly item: ToolCallTimelineItem; readonly threadId: string }) {
  const openChannel = useDelegateChannel()
  const subagents = useAssistantSubagents(threadId)
  const rows = delegateRowsOf(item, subagents)

  return (
    <section className="timeline-delegates">
      {rows.map((row) => (
        <DelegateLine
          key={row.agentId === '' ? item.toolCallId : row.agentId}
          row={row}
          onOpen={
            row.agentId === ''
              ? undefined
              : () => {
                  openChannel(row.agentId, row.description)
                }
          }
        />
      ))}
    </section>
  )
}

// 活动流里的一条记事，不是一张卡（外框圆角归 [data-surface]）。
// 抽屉收起就不挂载，两个面的 markdown 只在点开时解析。
export function ToolCallCard({
  isInFlight,
  isOpen,
  item,
  onToggle,
  threadId,
}: {
  readonly isInFlight: boolean
  readonly isOpen: boolean
  readonly item: ToolCallTimelineItem
  readonly onToggle: () => void
  /** 这一行属于哪条线程：子代理的生命周期（描述与状态）按它那条时间线读。 */
  readonly threadId: string
}) {
  const view = describeToolCall(item, isInFlight)

  // 派发的账目在它自己的通道里，这一行只是入口。一个子代理一行，照 ZCode 的 Agent 摘要行
  // （脸 + 身份色的类型名 + 那句描述）；运行与完成由脸和角标说，行里不再有工具名与状态词。
  if (isDelegation(item)) {
    return <DelegateRows item={item} threadId={threadId} />
  }

  return (
    <section className="timeline-tool">
      <ToolCallHeader isOpen={isOpen} item={item} onToggle={onToggle} view={view} />

      <DisclosureBody isOpen={isOpen}>
        <ToolCallPanels isRunning={view.isRunning} item={item} />
      </DisclosureBody>
    </section>
  )
}
