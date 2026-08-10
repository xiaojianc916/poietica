import './shimmer.css'
import './tool-group.css'

import type { FeedRow, ToolCallTimelineItem } from '@poietica/agent'
import type { ReactNode } from 'react'
import { cx } from '../primitives/class-names'
import { DisclosureBody, useDisclosure } from '../primitives/disclosure'
import { ChevronDownIcon } from '../primitives/icons'
import { ToolKindIcon } from './tool-call-card'
import type { ToolGroupKind, ToolGroupPlan } from './tool-group'

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

export interface ToolGroupCardProps {
  readonly plan: ToolGroupPlan
  /** 成员照转录那一份画，两条通道因此长同一个样子。 */
  readonly renderRow: (row: FeedRow) => ReactNode
}

export function ToolGroupCard({ plan, renderRow }: ToolGroupCardProps) {
  const { isOpen, toggle } = useDisclosure(false)

  /* 组里还有人在跑，汇总行就跟着闪 —— 收起时那道光是唯一还能说出「正在做」的东西。
     判据借 FeedRow.isInFlight：它已经把「这一轮还在飞」与「这次调用还没有终态」两件事
     合过了（feed-rows.ts 的 inFlightAt），这里不重判一遍。 */
  const isRunning = plan.members.some((row) => row.isInFlight)

  return (
    <section className="timeline-group" data-open={isOpen ? 'true' : undefined}>
      <button
        aria-expanded={isOpen}
        className="timeline-group__header"
        onClick={toggle}
        type="button"
      >
        <ToolKindIcon kind={ICON_OF[plan.kind]} />

        <span className={cx('timeline-group__label', isRunning && 'timeline-shimmer')}>
          {describeToolGroup(plan)}
        </span>

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
