import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolCallStatus, ToolKind } from '../../../agent/tool-call'
import { type Presentation, selectPresentation, type ToolGroupPlan } from '../../../timeline/presentation'
import type { TimelineItem, TimelineState, ToolCallTimelineItem } from '../../../timeline/timeline-contract'
import { sayProcessSummary } from '../../semantics/tool-intent'
import { ToolGroupCard } from '../tool-group-card'

/*
 * 过程组：read / execute 与夹在它们中间的思考连成一条记事。
 *
 * 两条要求钉在投影那一层，不靠渲染结果反推：
 *   • 思考从头到尾不落成行，只在组头一闪；落定之后整段消失，历史回放也不出现；
 *   • 别的工具类别（edit 等）分组一点没动，思考对它们仍是隔断。
 */

const CSS = readFileSync(fileURLToPath(new URL('../tool-group.css', import.meta.url)), 'utf8')
const FLOW = readFileSync(fileURLToPath(new URL('../flow-row.css', import.meta.url)), 'utf8')
const TOKENS = readFileSync(
  fileURLToPath(new URL('../../../../../../../packages/design-system/src/tokens/assistant.css', import.meta.url)),
  'utf8',
)

function ask(id = 'ask'): TimelineItem {
  return { type: 'user_message', id, turn: 0, at: 0, text: '看看仓库' }
}

function tool(id: string, kind: ToolKind, status: ToolCallStatus = 'completed'): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id,
    turn: 0,
    at: 0,
    toolCallId: `call-${id}`,
    title: kind,
    invokedTool: kind,
    scheme: '',
    kind,
    headline: '',
    subject: '',
    shape: 'flow',
    status,
    requestContent: [],
    content: [],
    locations: [],
    channels: [],
    startedAt: 0,
    endedAt: 1,
  }
}

function thought(id: string, text: string): TimelineItem {
  return { type: 'agent_thought', id, turn: 0, at: 0, text, sealed: false }
}

/** 缺省是一条已经收口的对话；running 时用它跑流式尾巴。 */
function stateOf(items: readonly TimelineItem[], running = false): TimelineState {
  return {
    status: running ? 'running' : 'idle',
    backgroundTasks: [],
    subagents: [],
    sealed: [],
    active: running
      ? {
          turn: 0,
          run: { settled: false, undoCount: null, forkUnavailableReason: null },
          items,
        }
      : { turn: 0, items },
    lastSeq: 0,
    spans: [],
  }
}

function planAt(feed: Presentation, index: number): ToolGroupPlan {
  const plan = feed.groupAt(index)

  if (plan === undefined) {
    throw new Error(`第 ${String(index)} 行不是组头`)
  }

  return plan
}

const nothing = (): void => undefined

describe('过程组的投影', () => {
  it('read / execute / 思考连成一条过程，思考不在成员列表里', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read'), tool('e', 'execute'), thought('t', '先读配置')]),
      new Map(),
    )

    expect(feed.count).toBe(2)

    const plan = planAt(feed, 1)

    expect(plan.kind).toBe('process')
    expect(plan.members.map((row) => row.item.id)).toEqual(['r', 'e', 't'])
    expect(plan.tools.map((row) => row.item.id)).toEqual(['r', 'e'])
  })

  it('单条 read 加一条思考成组；单条 read 自己仍是单行', () => {
    const paired = selectPresentation(stateOf([ask(), tool('r', 'read'), thought('t', '看看这个文件')]), new Map())

    expect(paired.count).toBe(2)
    expect(planAt(paired, 1).tools.map((row) => row.item.id)).toEqual(['r'])

    const alone = selectPresentation(stateOf([ask(), tool('r', 'read')]), new Map())

    expect(alone.count).toBe(2)
    expect(alone.groupAt(1)).toBeUndefined()
  })

  it('落定的纯思考整段消失：不落行，也不进组内列表', () => {
    const pure = selectPresentation(stateOf([ask(), thought('t', '想过就算了')]), new Map())

    expect(pure.count).toBe(1)

    const mixed = selectPresentation(stateOf([ask(), tool('r', 'read'), thought('t', '想过就算了')]), new Map())

    expect(mixed.count).toBe(2)
    expect(planAt(mixed, 1).tools.map((row) => row.item.id)).toEqual(['r'])
  })

  it('流式里的思考借组头一闪：只出一条组头，没有可展开的成员', () => {
    const feed = selectPresentation(stateOf([ask(), thought('t', '先看看仓库结构\n再读配置')], true), new Map())

    expect(feed.count).toBe(2)

    const plan = planAt(feed, 1)

    expect(plan.kind).toBe('process')
    expect(plan.tools).toEqual([])
  })

  it('edit 那种旧分组一点没动：相邻仍合组，中间隔一条思考就不跨过去', () => {
    const merged = selectPresentation(stateOf([ask(), tool('a', 'edit'), tool('b', 'edit')]), new Map())

    expect(merged.count).toBe(2)
    expect(planAt(merged, 1).kind).toBe('edit')
    expect(planAt(merged, 1).tools).toHaveLength(2)

    const separated = selectPresentation(
      stateOf([ask(), tool('a', 'edit'), thought('t', '想想怎么改'), tool('b', 'edit')]),
      new Map(),
    )

    expect(separated.count).toBe(3)
    expect(separated.groupAt(1)).toBeUndefined()
    expect(separated.groupAt(2)).toBeUndefined()
  })
})

describe('过程组的组头', () => {
  it('纯思考只有一闪，不是控件，也不戴工具那道常亮的光', () => {
    const feed = selectPresentation(stateOf([ask(), thought('t', '先看看仓库结构\n再读配置')], true), new Map())
    const markup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(feed, 1)} renderRow={() => null} />,
    )

    expect(markup).toContain('再读配置')
    expect(markup).not.toContain('aria-expanded')
    expect(markup).not.toContain('timeline-shimmer')
    /* 思考那一格不给图标：这一行自己在换字，左边再挂一枚不动的字形是两套说法。 */
    expect(markup).not.toContain('timeline-row__icon')
  })

  it('工具还在跑的时候组头亮着，印的是它自己那句现场', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), tool('e', 'execute', 'in_progress')], true),
      new Map(),
    )
    const markup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(feed, 1)} renderRow={() => null} />,
    )

    expect(markup).toContain('timeline-shimmer')
  })

  it('组头正在印思考时不戴工具那道常亮的光，只有换字的一闪', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), thought('t', '第一行\n还在想')], true),
      new Map(),
    )
    const markup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(feed, 1)} renderRow={() => null} />,
    )

    expect(markup).toContain('还在想')
    expect(markup).not.toContain('timeline-shimmer')
    /* 组头此刻印的是思考：图标让位，行首就是那句话。 */
    expect(markup).not.toContain('timeline-row__icon')
  })

  it('组头印工具调用的时候图标照旧在', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), tool('e', 'execute')], true),
      new Map(),
    )
    const markup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(feed, 1)} renderRow={() => null} />,
    )

    expect(markup).toContain('timeline-row__icon')
  })

  it('思考那一格按阅读栏的量度走，与输入框同宽', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), thought('t', '第一行\n正在读配置')], true),
      new Map(),
    )
    const markup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(feed, 1)} renderRow={() => null} />,
    )

    /* 量度归阅读栏：flow-row.css 的 [data-measure="prose"] 把量度放开到整列，而那一列
       与输入框同宽（都由 --cp-grid 解出）。不收在工具那一档的 38rem 上。 */
    expect(markup).toContain('data-measure="prose"')
  })

  it('量度钉在输入框那一档，不再解成环形百分比', () => {
    /* 100% 在网格的固有尺寸计算里当 auto 用：思考在写的时候内层是 max-content，
       轨道会被这句话反过来撑开 —— 那一行的量度必须有确定的宽度可解。 */
    const at = FLOW.indexOf('.timeline-row[data-measure="prose"]')
    const rule = FLOW.slice(at, FLOW.indexOf('}', at))

    expect(rule).toContain('--cp-row-measure: var(--cp-input-max)')
    expect(rule).not.toContain('100%')
  })

  it('过程组的轨道先钉成可用宽，内容撑不出去', () => {
    const at = CSS.indexOf('.timeline-group {')
    const rule = CSS.slice(at, CSS.indexOf('}', at))

    expect(rule).toContain('grid-template-columns: minmax(0, 1fr)')
  })

  it('印工具调用的时候仍收在工具那一档量度里', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), tool('e', 'execute')], true),
      new Map(),
    )
    const markup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(feed, 1)} renderRow={() => null} />,
    )

    /* 不给 data-measure：.timeline-row 的默认量度就是工具那一档（路径与命令）。 */
    expect(markup).not.toContain('data-measure')
  })

  it('摊开只画工具成员，落定的账目按截图那一句报', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read'), thought('t', '想'), tool('e', 'execute')]),
      new Map(),
    )
    const rendered: string[] = []
    const markup = renderToStaticMarkup(
      <ToolGroupCard
        isOpen
        onToggle={nothing}
        plan={planAt(feed, 1)}
        renderRow={(row) => {
          rendered.push(row.item.id)
          return null
        }}
      />,
    )

    expect(rendered).toEqual(['r', 'e'])
    expect(markup).toContain('已读取文件运行了命令')
    expect(markup).toContain('data-scrollable')
    /* 两端那道雾：首帧还没量过，四态是 none（不画雾），量过之后按 scrollTop 换。 */
    expect(markup).toContain('data-scroll-mask="none"')
  })
})

describe('过程组的账目与成员列表', () => {
  it('只有 read 说已读取文件，只有 execute 说运行了命令，两样都有就合起来说', () => {
    expect(sayProcessSummary(1, 0)).toBe('已读取文件')
    expect(sayProcessSummary(0, 1)).toBe('运行了命令')
    expect(sayProcessSummary(2, 3)).toBe('已读取文件运行了命令')
  })

  it('成员列表封顶并自己滚，高度与雾的跑道都来自令牌', () => {
    const at = CSS.indexOf('.timeline-group__members {')
    const close = CSS.indexOf('}', at)
    const rule = CSS.slice(at, close)

    expect(rule).toContain('max-block-size: var(--cp-timeline-group-max)')
    expect(rule).toContain('overflow: hidden auto')
    expect(TOKENS).toContain('--cp-timeline-group-max:')
    expect(TOKENS).toContain('--cp-timeline-group-fade:')
  })

  it('两端那道雾只按四态画，到头的那一端不挂渐变', () => {
    /* 四态各自一条规则：都藏着、只上端、只下端、都不藏（没有规则）。 */
    for (const state of ['both', 'top', 'bottom']) {
      expect(CSS).toContain(`[data-scroll-mask="${state}"]`)
    }

    /* data-scroll-mask="none" 没有对应的 mask-image —— 到头了就不该再有渐隐。 */
    expect(CSS).not.toContain('[data-scroll-mask="none"]')

    /* 中间那一段一律不许变淡：两个停靠点之间是纯黑。 */
    const both = CSS.slice(CSS.indexOf('[data-scroll-mask="both"]'))
    expect(both.slice(0, both.indexOf('}'))).toContain('#000 var(--cp-timeline-group-fade)')
  })
})
