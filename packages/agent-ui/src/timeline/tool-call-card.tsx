import './shimmer.css'
import './tool-call.css'

import type { ToolCallTimelineItem } from '@poietica/agent'
import { cx } from '../primitives/class-names'
import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
import {
  ChevronDownIcon,
  FileIcon,
  GlobeIcon,
  ModelIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  ToolIcon,
} from '../primitives/icons'
import { type ToolCallFacets, toToolCallFacets } from '../semantics/tool-call-facets'
import { readToolIntent } from '../semantics/tool-intent'
import { readToolKind } from '../semantics/tool-kind'
import { ToolCallPanels } from './tool-call-panels'

/*
 * 协议那九档各自的字形。
 *
 * default 从此只接住 other 一档 —— 九档里其余八档都在上面点了名。所以扳手不再是
 * 「兜底」，它是一个确切的意思：这次调用没有报类别，而且入参的形状也认不出它在做
 * 什么（semantics/tool-kind.ts），而不是这里少写了一个 case。
 *
 * 这件事有实际用处：不报 kind 的调用不参与聚合（见 tool-group.ts 的白名单），于是
 * 「几条同类调用没有并起来」与「它们戴着扳手」是同一个原因的两个面，看一眼就够了。
 */
export function ToolKindIcon({ kind }: { readonly kind: ToolCallTimelineItem['kind'] }) {
  const className = 'timeline-tool__icon'

  switch (kind) {
    case 'edit':
      return <PencilIcon aria-hidden="true" className={className} />
    case 'delete':
    case 'move':
      return <FileIcon aria-hidden="true" className={className} />
    case 'read':
    case 'search':
      return <SearchIcon aria-hidden="true" className={className} />
    case 'fetch':
      return <GlobeIcon aria-hidden="true" className={className} />
    case 'execute':
      return <TerminalIcon aria-hidden="true" className={className} />
    case 'think':
      return <ModelIcon aria-hidden="true" className={className} />
    default:
      return <ToolIcon aria-hidden="true" className={className} />
  }
}

/** 这一行印出来的那句话。完整调用信息仍然位于可展开的详情中。 */
interface ToolCallLine {
  readonly text: string
}

interface ToolCallCardView {
  readonly facets: ToolCallFacets
  readonly line: ToolCallLine
  readonly isRunning: boolean
}

/*
 * 一个槽位只有一句话，所以这里交出的是一句话，而不是「三种来源里挑一个」。
 *
 * 上游有几路与这一行长什么样无关：投影层给了简报就用简报，否则从入参里读意图，
 * 两者都没有时印 agent 自己的话。派生在这一层收口，渲染层因此只认一个类名 ——
 * 否则同一个槽位会按来源分出两套排版，一屏里像两种控件。
 */
function readToolCallLine(
  item: ToolCallTimelineItem,
  brief: ToolCallFacets['brief'],
): ToolCallLine {
  if (brief !== null) {
    return { text: brief.label }
  }

  const intent = readToolIntent(item)

  if (intent !== null) {
    return { text: intent.text }
  }

  return { text: item.title }
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
    line: readToolCallLine(item, facets.brief),
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

/**
 * 这一行：一枚图标，一句话，指到才出现的箭头 —— 还在跑的时候，那句话上有一道光扫过。
 *
 * 子代理不是一种 ACP 工具类别（ToolKind 里没有它），所以图标那一格的分流在
 * 这一层，不在 ToolKindIcon 的 switch 里：那个 switch 认的是协议枚举。
 */
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
  const { brief, diffStat } = facets

  return (
    <button
      aria-expanded={isOpen}
      className="timeline-tool__header"
      onClick={onToggle}
      type="button"
    >
      {brief === null ? (
        <ToolKindIcon kind={readToolKind(item)} />
      ) : (
        <ModelIcon aria-hidden="true" className="timeline-tool__icon" />
      )}

      <span className={cx('timeline-tool__label', isRunning && 'timeline-shimmer')}>
        {line.text}
      </span>

      {brief?.isBackground === true ? (
        <span className="timeline-tool__background">后台</span>
      ) : null}

      <ToolCallDiffStat diffStat={diffStat} />

      <ChevronDownIcon aria-hidden="true" className="timeline-tool__chevron disclosure__chevron" />
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
  isInFlight,
  item,
}: {
  readonly isInFlight: boolean
  readonly item: ToolCallTimelineItem
}) {
  const view = describeToolCall(item, isInFlight)
  const { isOpen, toggle } = useDisclosure(false)

  return (
    <section className="timeline-tool" data-open={isOpen ? 'true' : undefined}>
      <ToolCallHeader isOpen={isOpen} item={item} onToggle={toggle} view={view} />

      <DisclosureBody isOpen={isOpen}>
        <ToolCallPanels facets={view.facets} isRunning={view.isRunning} />
      </DisclosureBody>
    </section>
  )
}
