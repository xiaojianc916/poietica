import './tool-group.css'

import {
  type FeedRow,
  liveMemberOf,
  type ToolCallTimelineItem,
  type ToolGroupKind,
  type ToolGroupPlan,
} from '@poietica/agent'
import type { ReactNode } from 'react'
import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
import { ChevronDownIcon } from '../primitives/icons'
import { readToolLine } from '../semantics/tool-intent'
import { GroupTicker } from './group-ticker'
import { ToolKindIcon } from './tool-call-card'

/**
 * 一组连续的同类调用。
 *
 * 两层折叠，两层都默认收起：这一行点开是成员列表，成员各自点开才是它自己的
 * Request / Response。组不替成员做那个决定。
 *
 * 不是一张卡：与 ToolCallCard 同一个音量，外框、圆角与投影仍归 [data-surface]，
 * 戴它的是需要人回答的东西。
 */

/** 组头那枚图标：借这一类里最有代表性的那一档，图标的实现仍只有一处。 */
const ICON_OF: Record<ToolGroupKind, ToolCallTimelineItem['kind']> = {
  execute: 'execute',
  fetch: 'fetch',
  read: 'read',
  search: 'search',
  write: 'edit',
}

/**
 * 汇总那一句。
 *
 * 量词跟着这一类真正在数的东西走：读与写数文件，搜索与执行数次数，抓取数网页。
 * 中文不变复数，所以这里只有一套写法，没有单复数分支。
 */
function describeToolGroup(plan: ToolGroupPlan): string {
  const count = plan.members.length

  switch (plan.kind) {
    case 'read':
      return `阅读 ${count} 个文件`
    case 'search':
      return `搜索 ${count} 次`
    case 'fetch':
      return `抓取 ${count} 个网页`
    case 'execute':
      return `执行 ${count} 条命令`
    case 'write':
      return `编辑 ${count} 个文件`
    default:
      return unhandled(plan.kind)
  }
}

/* 白名单长出新的一类时这里是编译错误，不是一行空白。 */
function unhandled(_kind: never): string {
  return ''
}

/**
 * 正在跑的那一条要印的那句话。
 *
 * 用的是成员行自己那一句，与展开之后看到的完全同一串 —— 组头不另起一套说法。取不到就退
 * 回派发的标题；连标题都是空的就返回 undefined，那时候印账目比印一片空白强。
 */
function sayingOf(row: FeedRow): string | undefined {
  const item = row.item

  if (item.type !== 'tool_call') {
    return undefined
  }

  const said = readToolLine(item)

  return said === '' ? undefined : said
}

export interface ToolGroupCardProps {
  readonly plan: ToolGroupPlan
  /** 成员照转录那一份画，两条通道因此长同一个样子。 */
  readonly renderRow: (row: FeedRow) => ReactNode
}

export function ToolGroupCard({ plan, renderRow }: ToolGroupCardProps) {
  const { isOpen, toggle } = useDisclosure(false)

  /* 组里还有人在跑，汇总行就跟着闪 —— 收起时那道光是唯一还能说出「正在做」的东西。
     判据借 FeedRow.isInFlight：它已经把「这一轮还在飞」与「这次调用还没有终态」两件事
     合过了（presentation.ts 的 inFlight），这里不重判一遍。 */
  const isRunning = plan.members.some((row) => row.isInFlight)

  /*
   * 组头说什么：跑的时候报现场，落定之后报账目。
   *
   * 展开时一律报账目。成员都摊在下面、各自带着状态了，组头再播一遍是同一句话说两遍 ——
   * 它会说话本来就是因为成员藏着。
   *
   * 顺带一句：跑的过程里那个计数本来就靠不住，成员是一条条到的，「3」下一秒可能是「5」。
   * 报现场不只是更好看，它比报账目更诚实。
   */
  const live = isOpen ? undefined : liveMemberOf(plan)
  const saying = live === undefined ? undefined : sayingOf(live)
  const summary = describeToolGroup(plan)

  /*
   * 这里不能叫 data-open。
   *
   * disclosure.css 的打开态是 [data-open="true"] .disclosure__reveal —— 后代选择器，
   * 而成员就长在组的抽屉里。属性一挂，组内每一个成员的抽屉会被同一条规则一起撑开，
   * 可它们各自的 isOpen 仍是 false，reveal 上还挂着 inert：盒子看着开着，里面的
   * VirtualProse 从没收到过「我有高度了」，滚也滚不动。开着的空盒子，正是这么来的。
   *
   * 所以开合的判据换个名字，由 tool-group.css 用子选择器自己接管 —— 那条路径够不到
   * 成员。原语一个字不动：它说的「调用方要覆盖外观照旧加自己的类」，指的就是这个。
   */
  return (
    <section className="timeline-group" data-expanded={isOpen ? 'true' : undefined}>
      {/* 可访问名钉死成账目那一句。轮播那一格每几百毫秒换一次内容，让它同时充当按钮的
          名字，等于让读屏用户的落脚点一直在动；而这个按钮的语义本来就是「这一组的汇总」，
          账目才是它的名字。代价是运行途中可见文字与可访问名对不上，语音操控要念账目那
          一句 —— 在这个取舍里我认为值得。 */}
      <button
        aria-expanded={isOpen}
        aria-label={summary}
        className="timeline-group__header"
        onClick={toggle}
        type="button"
      >
        <ToolKindIcon kind={ICON_OF[plan.kind]} />

        <GroupTicker isRunning={isRunning} text={saying ?? summary} />

        <ChevronDownIcon
          aria-hidden="true"
          className="timeline-group__chevron disclosure__chevron"
        />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div className="timeline-group__members">
          {plan.members.map((row) => (
            <div className="timeline-group__member" key={row.item.id}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      </DisclosureBody>
    </section>
  )
}
