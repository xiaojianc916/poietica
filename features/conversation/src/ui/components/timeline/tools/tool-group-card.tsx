import '../flow-row.css'
import './tool-group.css'

import { type DiffFile, type DiffStat, diffStatOf } from '@poietica/design-system/diff'
import type { ReactNode } from 'react'
import { type FeedRow, liveMemberOf, type ToolGroupPlan } from '../../../timeline/presentation'
import { DisclosureBody } from '../../primitives/disclosure'
import { ChevronDownIcon } from '../../primitives/icons'
import { useScrollMask } from '../../primitives/use-scroll-mask'
import { readThoughtSentence, type ThoughtSentences } from '../../semantics/thought-sentence'
import { toDiffFilesOf } from '../../semantics/tool-call-facets'
import { readToolLine, sayProcessSummary, sayToolCount } from '../../semantics/tool-intent'
import { RollingLine } from '../ticker/rolling-line'
import { ToolCallDiffStat, ToolGlyphIcon } from './tool-call-card'

/** 两层折叠都默认收起；思考不进成员列表（「想了一会儿」是过程，不是可点开的记录），只在组头一闪。 */

/** 取不到返回 undefined，由调用方退回账目，比印一片空白强。 */
function sayingOf(row: FeedRow, sentences: ThoughtSentences | null): string | undefined {
  const item = row.item

  if (item.type === 'tool_call') {
    const said = readToolLine(item)

    return said === '' ? undefined : said
  }

  if (item.type === 'agent_thought') {
    const said = sentences?.current.text ?? ''

    return said === '' ? undefined : said
  }

  return undefined
}

/** 组头身份，换句才刷一次：思考用起始偏移（同一句继续写是原地生长），工具调用用调用号。 */
function lineKeyOf(row: FeedRow, sentences: ThoughtSentences | null): string {
  const item = row.item

  if (item.type === 'agent_thought') {
    return `thought:${item.id}:${sentences?.current.key ?? ''}`
  }

  return item.type === 'tool_call' ? `call:${item.toolCallId}` : item.id
}

function statOf(plan: ToolGroupPlan): DiffStat | null {
  const files: DiffFile[] = []

  for (const row of plan.tools) {
    if (row.item.type === 'tool_call') {
      files.push(...toDiffFilesOf(row.item))
    }
  }

  return diffStatOf(files)
}

/** 同类相邻，字形取头一个成员即可。 */
function firstTool(plan: ToolGroupPlan): { readonly name: string; readonly scheme: string } {
  const head = plan.tools[0]?.item

  return head?.type === 'tool_call' ? { name: head.invokedTool, scheme: head.scheme } : { name: '', scheme: '' }
}

/** 按基准截图：过程组报「已读取文件 / 运行了命令」，其余类别沿用各自的计数句。 */
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
  readonly isOpen: boolean
  readonly onToggle: () => void
  readonly plan: ToolGroupPlan
  readonly renderRow: (row: FeedRow) => ReactNode
}

export function ToolGroupCard({ isOpen, onToggle, plan, renderRow }: ToolGroupCardProps) {
  const members = useScrollMask()

  /* 跑的时候报现场（计数靠不住，「3」下一秒可能就是「5」）、落定之后报账目；思考不在成员列表里，只在这里说。 */
  const live = liveMemberOf(plan)
  /* 一次渲染只取一次句：`saying` 与 `lineKey` 都要它，两次调用会在同一段文本上各扫一遍。 */
  const sentences = live?.item.type === 'agent_thought' ? readThoughtSentence(live.item.text) : null
  const saying = live === undefined ? undefined : sayingOf(live, sentences)
  const summary = summaryOf(plan)
  /* 扫光说明「这次调用还没完」，只归正在说话的工具调用；思考靠换字刷动，不戴它。 */
  const isRunning = live?.item.type === 'tool_call' && live.isInFlight
  const thinking = live?.item.type === 'agent_thought'
  /* 思考刚开始一个字都没有时也戴扫光：有字之后换字本身就说明在动。 */
  const placeholder = thinking && saying === undefined
  const text = saying ?? (thinking ? '正在思考' : summary)
  const lineKey = live === undefined ? 'summary' : lineKeyOf(live, sentences)
  /* 思考句像显示屏一样滚（最新的字永远在右边缘以内）；工具行从头显示、末尾省略号，动词和对象在开头。 */
  const following = live !== undefined
  /* 思考按整列量度走：它是模型原话，截在 38rem 上只剩半句；工具那一句收在 38rem 反而好扫。 */
  const measure = thinking ? 'prose' : undefined

  if (plan.tools.length === 0) {
    return (
      <section className="timeline-group">
        <div className="timeline-row" data-measure="prose">
          {/* 不给图标：这行本身在换字，再挂一枚不动的字形读起来像「有东西在动」。 */}
          <RollingLine
            contentKey={lineKey}
            following={following}
            previous={sentences?.previous ?? null}
            shimmer={placeholder}
            text={text}
            variant="thought"
          />
        </div>
      </section>
    )
  }

  return (
    <section className="timeline-group">
      {/* 可访问名钉死成账目那一句：轮播格每几百毫秒换一次，跟着换会让读屏用户的落脚点一直在动。 */}
      <button
        aria-expanded={isOpen}
        aria-label={summary}
        className="timeline-row"
        data-measure={measure}
        onClick={onToggle}
        type="button"
      >
        {thinking ? null : <ToolGlyphIcon {...firstTool(plan)} />}

        <RollingLine
          contentKey={lineKey}
          following={following}
          previous={sentences?.previous ?? null}
          shimmer={isRunning || placeholder}
          text={text}
          variant={thinking ? 'thought' : 'tool'}
        />

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
