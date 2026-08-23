import './flow-row.css'
import './shimmer.css'
import './tool-call.css'

import type { ToolCallTimelineItem } from '@poietica/agent'
import { cx } from '../primitives/class-names'
import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
import {
  ChevronDownIcon,
  FileIcon,
  GlobeIcon,
  GoalIcon,
  ModelIcon,
  PencilIcon,
  PlanIcon,
  PreviewIcon,
  SearchIcon,
  SkillIcon,
  SwarmIcon,
  TerminalIcon,
  ToolIcon,
} from '../primitives/icons'
import { type ToolCallFacets, toToolCallFacets } from '../semantics/tool-call-facets'
import { readToolLine } from '../semantics/tool-intent'
import { ToolCallPanels } from './tool-call-panels'

/*
 * 十三档各自的字形。扳手只剩一个确切的意思：kap 没给 display。
 *
 * 末尾那道 never：协议长出新档时这里是编译错误，不是一枚沉默的扳手。
 */
export function ToolKindIcon({ kind }: { readonly kind: ToolCallTimelineItem['kind'] }) {
  const className = 'timeline-row__icon'

  switch (kind) {
    case 'read':
      return <FileIcon aria-hidden="true" className={className} />
    case 'write':
    case 'edit':
      return <PencilIcon aria-hidden="true" className={className} />
    case 'search':
      return <SearchIcon aria-hidden="true" className={className} />
    case 'fetch':
      return <GlobeIcon aria-hidden="true" className={className} />
    case 'execute':
      return <TerminalIcon aria-hidden="true" className={className} />
    case 'delegate':
      return <ModelIcon aria-hidden="true" className={className} />
    case 'skill':
      return <SkillIcon aria-hidden="true" className={className} />
    case 'todo':
      return <PlanIcon aria-hidden="true" className={className} />
    case 'plan':
      return <PreviewIcon aria-hidden="true" className={className} />
    case 'task':
      return <SwarmIcon aria-hidden="true" className={className} />
    case 'goal':
      return <GoalIcon aria-hidden="true" className={className} />
    case 'other':
      return <ToolIcon aria-hidden="true" className={className} />
    default:
      return unreachable(kind)
  }
}

function unreachable(_kind: never): null {
  return null
}

interface ToolCallCardView {
  readonly facets: ToolCallFacets
  readonly line: string
  readonly isRunning: boolean
}

/*
 * isRunning 的两个条件缺一不可：这一轮还在飞，并且这次调用还没有收到终态。后半
 * 句单独用不得 —— status 是 agent 说过的话，一次没等到终态的调用会永远停在
 * in_progress。轮次是否还在飞由读模型说。
 *
 * 它有两个去处：抽屉里那句空态文案（还在跑，所以还没有返回），以及这一行的字上扫过
 * 的那道光。除此之外标题栏不画状态 —— 失败与耗时不在这一行上说。
 *
 * 开合不属于这份投影：默认收起，此后只响应用户点击。
 */
function describeToolCall(item: ToolCallTimelineItem, isInFlight: boolean): ToolCallCardView {
  const facets = toToolCallFacets(item)

  return {
    facets,
    isRunning: isInFlight && (item.status === 'pending' || item.status === 'in_progress'),
    line: readToolLine(item),
  }
}

/** 加减了多少行。两边都是零就不占位。 */
function ToolCallDiffStat({ diffStat }: { readonly diffStat: ToolCallFacets['diffStat'] }) {
  if (diffStat === null || diffStat.added + diffStat.removed === 0) {
    return null
  }

  return (
    <span className="timeline-tool__diffstat">
      {diffStat.added > 0 ? (
        <span className="timeline-tool__diffstat-added">+{diffStat.added}</span>
      ) : null}
      {diffStat.removed > 0 ? (
        <span className="timeline-tool__diffstat-removed">-{diffStat.removed}</span>
      ) : null}
    </span>
  )
}

/** 这一行：一枚图标，一句话，指到才出现的箭头 —— 还在跑的时候，那句话上有一道光扫过。 */
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
  const { facets, isRunning, line } = view
  const { diffStat } = facets

  return (
    <button aria-expanded={isOpen} className="timeline-row" onClick={onToggle} type="button">
      <ToolKindIcon kind={item.kind} />

      <span className={cx('timeline-row__label', isRunning && 'timeline-shimmer')}>{line}</span>

      {item.isBackground === true ? <span className="timeline-tool__background">后台</span> : null}

      <ToolCallDiffStat diffStat={diffStat} />

      <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
    </button>
  )
}

/**
 * One tool call, from the moment it is announced to the moment it settles.
 *
 * 不是一张卡：外框、圆角与投影归 [data-surface]，戴它的是需要人回答的东西。这
 * 一行是活动流里的一条记事，和思考链那一行同一个音量。
 *
 * 抽屉：内容常驻挂载，0fr 与 1fr 之间一次跳变，收起时 inert。不补间 —— 这一行
 * 挂着虚拟器的 measureElement，补间高度就是每帧让它下面所有行重排一次。
 *
 * 一次投影、两个渲染器。不包 memo —— 唯一的调用点 TimelineRow 已经按 row 记忆
 * 化，再包一层只是多一次比较。
 */
export function ToolCallCard({
  cacheKey,
  isInFlight,
  item,
}: {
  readonly cacheKey: string
  readonly isInFlight: boolean
  readonly item: ToolCallTimelineItem
}) {
  const view = describeToolCall(item, isInFlight)
  const { isOpen, toggle } = useDisclosure(false)

  return (
    <section className="timeline-tool" data-open={isOpen ? 'true' : undefined}>
      <ToolCallHeader isOpen={isOpen} item={item} onToggle={toggle} view={view} />

      <DisclosureBody isOpen={isOpen}>
        <ToolCallPanels
          cacheKey={cacheKey}
          facets={view.facets}
          isRunning={view.isRunning}
          kind={item.kind}
        />
      </DisclosureBody>
    </section>
  )
}
