import '../flow-row.css'
import '../ticker/shimmer.css'
import './tool-call.css'
import './tool-group.css'

import { cn, GithubMark } from '@poietica/design-system'
import { type DiffStat, diffStatOf } from '@poietica/design-system/diff'
import type { ComponentType } from 'react'
import type { ToolGlyph } from '../../../shared/model/tool-call'
import { DisclosureBody } from '../../../shared/primitives/disclosure'
import {
  BrainIcon,
  BugIcon,
  ChevronDownIcon,
  ClockIcon,
  ComputerIcon,
  DeviceIcon,
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
} from '../../../shared/primitives/icons'
import { toDiffFilesOf } from '../../../shared/semantics/tool-call-facets'
import type { ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { toolGlyphOf } from '../../../shared/tools/omp-tool-glyphs'
import { clampToLine, readToolLine, sayToolCount } from '../../../shared/tools/tool-intent'
import { isDelegation } from '../../delegate-channel'
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
  isChannel,
  isOpen,
  item,
  onToggle,
  view,
}: {
  readonly isChannel: boolean
  readonly isOpen: boolean
  readonly item: ToolCallTimelineItem
  readonly onToggle: () => void
  readonly view: ToolCallCardView
}) {
  const { diffStat, isRunning, line } = view

  return (
    <button aria-expanded={isChannel ? undefined : isOpen} className="timeline-row" onClick={onToggle} type="button">
      <ToolGlyphIcon name={item.invokedTool} scheme={item.scheme} />

      <span className={cn('timeline-row__label', isRunning && 'timeline-shimmer')}>{line}</span>

      {item.isBackground === true ? <span className="timeline-tool__background">后台</span> : null}

      <ToolCallDiffStat diffStat={diffStat} />

      {isChannel ? null : <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />}
    </button>
  )
}

// 活动流里的一条记事，不是一张卡（外框圆角归 [data-surface]）。
// 抽屉收起就不挂载，两个面的 markdown 只在点开时解析。
export function ToolCallCard({
  isInFlight,
  isOpen,
  item,
  onToggle,
}: {
  readonly isInFlight: boolean
  readonly isOpen: boolean
  readonly item: ToolCallTimelineItem
  readonly onToggle: () => void
}) {
  const view = describeToolCall(item, isInFlight)
  const openChannel = useDelegateChannel()

  // 派发的账目在它自己的通道里，这一行只是入口。
  if (isDelegation(item)) {
    const [only] = item.channels

    if (only !== undefined && item.channels.length === 1) {
      return (
        <section className="timeline-tool">
          <ToolCallHeader
            isChannel
            isOpen={false}
            item={item}
            onToggle={() => {
              openChannel(only.agentId)
            }}
            view={view}
          />
        </section>
      )
    }

    return (
      <section className="timeline-group">
        <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
          <ToolGlyphIcon name={item.invokedTool} scheme={item.scheme} />

          <span className={cn('timeline-row__label', view.isRunning && 'timeline-shimmer')}>
            {sayToolCount(item.kind, item.channels.length)}
          </span>

          <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
        </button>

        <DisclosureBody isOpen={isOpen}>
          <div className="timeline-group__members">
            {item.channels.map((channel) => (
              <div className="timeline-group__member" key={channel.agentId}>
                <button
                  className="timeline-row"
                  onClick={() => {
                    openChannel(channel.agentId)
                  }}
                  title={channel.name}
                  type="button"
                >
                  <ToolGlyphIcon name={item.invokedTool} scheme={item.scheme} />

                  <span className="timeline-row__label">{clampToLine(channel.name) ?? channel.name}</span>
                </button>
              </div>
            ))}
          </div>
        </DisclosureBody>
      </section>
    )
  }

  return (
    <section className="timeline-tool">
      <ToolCallHeader isChannel={false} isOpen={isOpen} item={item} onToggle={onToggle} view={view} />

      <DisclosureBody isOpen={isOpen}>
        <ToolCallPanels isRunning={view.isRunning} item={item} />
      </DisclosureBody>
    </section>
  )
}
