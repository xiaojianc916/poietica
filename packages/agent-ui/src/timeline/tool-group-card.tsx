import './flow-row.css'
import './tool-group.css'

import { type FeedRow, liveMemberOf, type ToolGroupPlan } from '@poietica/agent'
import { type DiffFile, type DiffStat, diffStatOf } from '@poietica/review'
import type { ReactNode } from 'react'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon } from '../primitives/icons'
import { toDiffFilesOf } from '../semantics/tool-call-facets'
import { readToolLine, sayToolCount } from '../semantics/tool-intent'
import { GroupTicker } from './group-ticker'
import { ToolCallDiffStat, ToolKindIcon } from './tool-call-card'

/**
 * 一组连续的同类调用。
 *
 * 两层折叠，两层都默认收起：这一行点开是成员列表，成员各自点开才是它自己的
 * Request / Response。组不替成员做那个决定。
 *
 * 不是一张卡：与 ToolCallCard 同一个音量，外框、圆角与投影仍归 [data-surface]，
 * 戴它的是需要人回答的东西。
 */

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

/** 组头那一对数字：成员各自算过的同一批改动，这里只做一次求和。 */
function statOf(plan: ToolGroupPlan): DiffStat | null {
  const files: DiffFile[] = []

  for (const row of plan.members) {
    if (row.item.type === 'tool_call') {
      files.push(...toDiffFilesOf(row.item))
    }
  }

  return diffStatOf(files)
}

export interface ToolGroupCardProps {
  /** 开合归转录那一层，按这一组自己的 id 记账。 */
  readonly isOpen: boolean
  readonly onToggle: () => void
  readonly plan: ToolGroupPlan
  /** 成员照转录那一份画，两条通道因此长同一个样子。 */
  readonly renderRow: (row: FeedRow) => ReactNode
}

export function ToolGroupCard({ isOpen, onToggle, plan, renderRow }: ToolGroupCardProps) {
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
  const summary = sayToolCount(plan.kind, plan.members.length)

  return (
    <section className="timeline-group">
      {/* 可访问名钉死成账目那一句。轮播那一格每几百毫秒换一次内容，让它同时充当按钮的
          名字，等于让读屏用户的落脚点一直在动；而这个按钮的语义本来就是「这一组的汇总」，
          账目才是它的名字。代价是运行途中可见文字与可访问名对不上，语音操控要念账目那
          一句 —— 在这个取舍里我认为值得。 */}
      <button
        aria-expanded={isOpen}
        aria-label={summary}
        className="timeline-row"
        onClick={onToggle}
        type="button"
      >
        <ToolKindIcon kind={plan.kind} />

        <GroupTicker isRunning={isRunning} text={saying ?? summary} />

        <ToolCallDiffStat diffStat={statOf(plan)} />

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
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
