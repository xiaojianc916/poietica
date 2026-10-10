import './flow-row.css'
import './tool-group.css'

import { type DiffFile, type DiffStat, diffStatOf } from '@poietica/design-system/diff'
import type { ReactNode } from 'react'
import { type FeedRow, liveMemberOf, type ToolGroupPlan } from '../../timeline/presentation'
import { DisclosureBody } from '../primitives/disclosure'
import { ChevronDownIcon } from '../primitives/icons'
import { useScrollMask } from '../primitives/use-scroll-mask'
import { readThoughtLine } from '../semantics/thought-line'
import { toDiffFilesOf } from '../semantics/tool-call-facets'
import { readToolLine, sayProcessSummary, sayToolCount } from '../semantics/tool-intent'
import { RollingLine } from './rolling-line'
import { ToolCallDiffStat, ToolGlyphIcon } from './tool-call-card'

/**
 * 一组连续的过程：read / execute 与夹在它们中间的思考。
 *
 * 两层折叠，两层都默认收起：这一行点开是成员列表，成员各自点开才是它自己的
 * Request / Response。组不替成员做那个决定。
 *
 * 思考没有这两层：它从头到尾只在组头一闪。展开的成员列表里没有它，它自己也不落行 ——
 * 「想了一会儿」是过程，不是一条可以点开的记录。
 *
 * 不是一张卡：与 ToolCallCard 同一个音量，外框、圆角与投影仍归 [data-surface]，
 * 戴它的是需要人回答的东西。
 */

/**
 * 正在跑的那一条要印的那句话。
 *
 * 用的是成员行自己那一句，与展开之后看到的完全同一串 —— 组头不另起一套说法。取不到就退
 * 回派发的标题；连标题都是空的就返回 undefined，那时候印账目比印一片空白强。思考印
 * 的是它此刻写到的那一行，与它自己流式时那一行同源。
 */
function sayingOf(row: FeedRow): string | undefined {
  const item = row.item

  if (item.type === 'tool_call') {
    const said = readToolLine(item)

    return said === '' ? undefined : said
  }

  if (item.type === 'agent_thought') {
    const said = readThoughtLine(item.text).text

    return said === '' ? undefined : said
  }

  return undefined
}

/**
 * 组头那一格此刻的身份：换格才翻页。
 *
 * 推理给的是它在原文里的行号 —— 同一行继续写是原地刷新（这才是「刷刷刷」），换行才是
 * 换了一格；工具调用给调用号，一条调用从头到尾就那一句。
 */
function lineKeyOf(row: FeedRow): string {
  const item = row.item

  if (item.type === 'agent_thought') {
    return `thought:${item.id}:${readThoughtLine(item.text).key}`
  }

  return item.type === 'tool_call' ? `call:${item.toolCallId}` : item.id
}

/** 组头那一对数字：成员各自算过的同一批改动，这里只做一次求和。 */
function statOf(plan: ToolGroupPlan): DiffStat | null {
  const files: DiffFile[] = []

  for (const row of plan.tools) {
    if (row.item.type === 'tool_call') {
      files.push(...toDiffFilesOf(row.item))
    }
  }

  return diffStatOf(files)
}

/** 组头那一枚字形取头一个工具成员：一组就是同类相邻，头一个说了算。 */
function firstTool(plan: ToolGroupPlan): { readonly name: string; readonly scheme: string } {
  const head = plan.tools[0]?.item

  return head?.type === 'tool_call' ? { name: head.invokedTool, scheme: head.scheme } : { name: '', scheme: '' }
}

/**
 * 落定之后组头报的账。
 *
 * 过程组按基准截图的口径报「已读取文件 / 运行了命令 / 已读取文件运行了命令」；
 * 其余类别沿用各自的计数句。
 */
function summaryOf(plan: ToolGroupPlan): string {
  if (plan.kind !== 'process') {
    return sayToolCount(plan.kind, plan.tools.length)
  }

  let reads = 0
  let executes = 0

  for (const row of plan.tools) {
    if (row.item.type !== 'tool_call') {
      continue
    }
    if (row.item.kind === 'read') {
      reads += 1
    } else {
      executes += 1
    }
  }

  return sayProcessSummary(reads, executes)
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
  /* 成员列表那一盒两端那道雾：这里只管算，画法归 tool-group.css。 */
  const members = useScrollMask()

  /*
   * 组头说什么：跑的时候报现场，落定之后报账目。
   *
   * 正在跑就报现场，哪怕展开着也一样：组头「实时显示正在做的那件事」是这一格的主职，
   * 成员列表负责的是各自的结果。思考更必须如此 —— 它不在成员列表里，除了组头那一闪
   * 没有任何地方会说出它。
   *
   * 顺带一句：跑的过程里那个计数本来就靠不住，成员是一条条到的，「3」下一秒可能是「5」。
   * 报现场不只是更好看，它比报账目更诚实。
   */
  const live = liveMemberOf(plan)
  const saying = live === undefined ? undefined : sayingOf(live)
  const summary = summaryOf(plan)
  /*
   * 那道扫过的光只归正在说话的工具调用：它说明「这次调用还没完」，一路亮到终态。
   * 组头此刻印的是思考（thinking 也是最后一条在动的成员）时不亮 —— 思考靠换字刷过，
   * 闪完就没了，常亮的那盏灯不是它的。
   */
  const isRunning = live?.item.type === 'tool_call' && live.isInFlight
  /* 组头此刻印的是思考还是工具，决定两件事：要不要图标、这一格的身份是什么。 */
  const thinking = live?.item.type === 'agent_thought'
  const text = saying ?? (thinking ? '正在思考' : summary)
  const lineKey = live === undefined ? 'summary' : lineKeyOf(live)
  /* 还有人动就跟着末尾走：这一格说的永远是「现在」那一句，被省略号吃掉最新几个字就白说了。 */
  const following = live !== undefined
  /*
   * 思考按阅读栏的量度走（data-measure="prose" = 整列，与输入框同宽），工具调用仍收在
   * 工具那一档（38rem，给路径与命令）。
   *
   * 理由是两句话的读者不同：工具那一句是「哪个文件、哪条命令」，短一截反而好扫；思考是
   * 模型的原话，一句话被截在 38rem 上就只剩半句 —— 而它此刻正是这一行的全部内容。
   * zcode 那边也是这个排法：推理那一行占满整行，与输入框同宽。
   */
  const measure = thinking ? 'prose' : undefined

  /* 纯思考：没有可展开的成员，它只是组头那一闪，不是控件。 */
  if (plan.tools.length === 0) {
    return (
      <section className="timeline-group">
        <div className="timeline-row" data-measure="prose">
          {/* 思考那一格不给图标：这一行的内容本身在换字，左边再挂一枚不动的字形，
              读起来是「这行在动」而不是「模型在想」。 */}
          <RollingLine contentKey={lineKey} following={following} text={text} />
        </div>
      </section>
    )
  }

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
        data-measure={measure}
        onClick={onToggle}
        type="button"
      >
        {thinking ? null : <ToolGlyphIcon {...firstTool(plan)} />}

        <RollingLine contentKey={lineKey} following={following} shimmer={isRunning} text={text} />

        <ToolCallDiffStat diffStat={statOf(plan)} />

        <ChevronDownIcon aria-hidden="true" className="timeline-row__chevron disclosure__chevron" />
      </button>

      <DisclosureBody isOpen={isOpen}>
        <div
          className="timeline-group__members"
          data-scroll-mask={members.mask}
          data-scrollable=""
          ref={members.viewport}
        >
          {plan.tools.map((row) => (
            <div className="timeline-group__member" key={row.item.id}>
              {renderRow(row)}
            </div>
          ))}
        </div>
      </DisclosureBody>
    </section>
  )
}
