import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolCallStatus, ToolKind } from '../../../shared/model/tool-call'
import type { TimelineItem, TimelineState, ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { sayFamilySummary } from '../../../shared/tools/tool-intent'
import { type Presentation, selectPresentation, type ToolGroupPlan } from '../../presentation'
import { ToolGroupCard } from '../tools/tool-group-card'

/* 过程组：阅读 / 搜索 / 运行命令与夹在它们中间的思考连成一条记事。要求钉在投影那一层，不靠渲染
 * 结果反推：思考从头到尾不落成行，只在组头一闪，落定后整段消失（历史回放也不出现）；思考对
 * 每一族都透明，edit / fetch 等同族相邻即使中间夹着思考也连成一条；成组只数工具，不数思考。 */

function ask(id = 'ask'): TimelineItem {
  return { type: 'user_message', id, turn: 0, at: 0, text: '看看仓库' }
}

/* 每个类别取一把真实的 omp 工具名：分族听的是名字与地址，不是 kind。 */
const NAMES: Readonly<Record<ToolKind, string>> = {
  delegate: 'task',
  edit: 'edit',
  execute: 'bash',
  fetch: 'fetch',
  goal: 'goal',
  other: 'think',
  read: 'read',
  search: 'grep',
  skill: 'manage_skill',
  todo: 'todo',
  write: 'write',
}

function tool(
  id: string,
  kind: ToolKind,
  status: ToolCallStatus = 'completed',
  name: string = NAMES[kind],
  scheme = '',
): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id,
    turn: 0,
    at: 0,
    toolCallId: `call-${id}`,
    title: kind,
    invokedTool: name,
    scheme,
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

function stateOf(items: readonly TimelineItem[], running = false): TimelineState {
  return {
    status: running ? 'running' : 'idle',
    todos: [],
    backgroundTasks: [],
    subagents: [],
    sealed: [],
    active: running
      ? {
          turn: 0,
          run: { settled: false, keepTurns: null, forkUnavailableReason: null },
          items,
        }
      : { turn: 0, items },
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

/* 思考句归逐帧引擎（只渲染窗口那一层），静态标记里看不到，要断言「印出来的是哪一句」就得真挂一次。 */
function renderHead(plan: ToolGroupPlan): HTMLElement {
  const { container } = render(
    <MotionConfig skipAnimations>
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={plan} renderRow={() => null} />
    </MotionConfig>,
  )

  return container
}

afterEach(() => {
  cleanup()
})

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

  it('成组只数工具：单条 read 加一条落定的思考仍是单行，没有箭头；思考还在流时才借组头一闪', () => {
    const paired = selectPresentation(stateOf([ask(), tool('r', 'read'), thought('t', '看看这个文件')]), new Map())

    expect(paired.count).toBe(2)
    expect(paired.groupAt(1)).toBeUndefined()
    expect(paired.rowAt(1)?.item.id).toBe('r')

    const leading = selectPresentation(stateOf([ask(), thought('t', '先看看'), tool('r', 'read')]), new Map())

    expect(leading.count).toBe(2)
    expect(leading.groupAt(1)).toBeUndefined()
    expect(leading.rowAt(1)?.item.id).toBe('r')

    const streaming = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), thought('t', '还在想')], true),
      new Map(),
    )

    expect(streaming.count).toBe(2)
    expect(planAt(streaming, 1).tools.map((row) => row.item.id)).toEqual(['r'])

    const alone = selectPresentation(stateOf([ask(), tool('r', 'read')]), new Map())

    expect(alone.count).toBe(2)
    expect(alone.groupAt(1)).toBeUndefined()
  })

  it('落定的纯思考整段消失：不落行，也不进组内列表', () => {
    const pure = selectPresentation(stateOf([ask(), thought('t', '想过就算了')]), new Map())

    expect(pure.count).toBe(1)

    const mixed = selectPresentation(stateOf([ask(), tool('r', 'read'), thought('t', '想过就算了')]), new Map())

    expect(mixed.count).toBe(2)
    expect(mixed.groupAt(1)).toBeUndefined()
    expect(mixed.rowAt(1)?.item.id).toBe('r')
  })

  it('流式里的思考借组头一闪：只出一条组头，没有可展开的成员', () => {
    const feed = selectPresentation(stateOf([ask(), thought('t', '先看看仓库结构\n再读配置')], true), new Map())

    expect(feed.count).toBe(2)

    const plan = planAt(feed, 1)

    expect(plan.kind).toBe('process')
    expect(plan.tools).toEqual([])
  })

  it('edit 相邻仍合组，中间夹一条思考也连成一条', () => {
    const merged = selectPresentation(stateOf([ask(), tool('a', 'edit'), tool('b', 'edit')]), new Map())

    expect(merged.count).toBe(2)
    expect(planAt(merged, 1).kind).toBe('edit')
    expect(planAt(merged, 1).tools).toHaveLength(2)

    const crossed = selectPresentation(
      stateOf([ask(), tool('a', 'edit'), thought('t', '想想怎么改'), tool('b', 'edit')]),
      new Map(),
    )

    expect(crossed.count).toBe(2)

    const plan = planAt(crossed, 1)

    expect(plan.kind).toBe('edit')
    expect(plan.members.map((row) => row.item.id)).toEqual(['a', 't', 'b'])
    expect(plan.tools.map((row) => row.item.id)).toEqual(['a', 'b'])
  })

  it('思考打头时由第一件工具定档：同档继续并，换档就断开', () => {
    const adopted = selectPresentation(
      stateOf([ask(), thought('t', '先抓一下'), tool('a', 'fetch'), tool('b', 'fetch')]),
      new Map(),
    )

    expect(adopted.count).toBe(2)
    expect(planAt(adopted, 1).kind).toBe('fetch')
    expect(planAt(adopted, 1).tools.map((row) => row.item.id)).toEqual(['a', 'b'])

    const broken = selectPresentation(
      stateOf([ask(), thought('t', '先抓一下'), tool('a', 'fetch'), tool('b', 'edit')]),
      new Map(),
    )

    /* fetch 只剩一条（思考不算数），edit 换族，各自一行。 */
    expect(broken.count).toBe(3)
    expect(broken.groupAt(1)).toBeUndefined()
    expect(broken.rowAt(1)?.item.id).toBe('a')
    expect(broken.groupAt(2)).toBeUndefined()
  })

  it('换档就断：思考并入左边那一组，不跨到另一种工具上', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('a', 'edit'), thought('t', '想想'), tool('b', 'fetch')]),
      new Map(),
    )

    expect(feed.count).toBe(3)
    expect(feed.groupAt(1)).toBeUndefined()
    expect(feed.rowAt(1)?.item.id).toBe('a')
    expect(feed.groupAt(2)).toBeUndefined()
  })
})

describe('过程组的组头', () => {
  it('纯思考只有一闪，不是控件，也不戴工具那道常亮的光', () => {
    const feed = selectPresentation(stateOf([ask(), thought('t', '先看看仓库结构\n再读配置')], true), new Map())
    const container = renderHead(planAt(feed, 1))
    const markup = container.innerHTML

    expect(markup).toContain('再读配置')
    expect(markup).not.toContain('aria-expanded')
    expect(markup).not.toContain('timeline-shimmer')
    /* 思考那一格不给图标：格子在换字，静图标是第二种说法。 */
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
    const container = renderHead(planAt(feed, 1))
    const markup = container.innerHTML

    expect(markup).toContain('还在想')
    expect(markup).not.toContain('timeline-shimmer')
    expect(markup).not.toContain('timeline-row__icon')
  })

  it('思考那一格走滚动，工具那一格从头显示', () => {
    /* 两个 variant 的几何不同（rolling-line.css）：思考往左滚、最新的字永远完整；工具行不动、
       从头显示，放不下时末尾省略号。 */
    const thinking = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), thought('t', '第一行\n还在想')], true),
      new Map(),
    )
    const thinkingMarkup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(thinking, 1)} renderRow={() => null} />,
    )

    expect(thinkingMarkup).toContain('data-variant="thought"')
    /* 还在写的思考句交给逐帧引擎：静态标记里只有窗口，轨道由客户端从头建。 */
    expect(thinkingMarkup).toContain('data-following')
    expect(thinkingMarkup).not.toContain('ticker-track')

    const running = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), tool('e', 'execute')], true),
      new Map(),
    )
    const runningMarkup = renderToStaticMarkup(
      <ToolGroupCard isOpen={false} onToggle={nothing} plan={planAt(running, 1)} renderRow={() => null} />,
    )

    expect(runningMarkup).toContain('data-variant="tool"')
    /* 工具行不动：静态标记里就是窗口加轨道，整句从头显示。 */
    expect(runningMarkup).toContain('ticker-track')
  })

  it('思考取的是当前那一句，不是最后一行：一整个长段落里也看得出换句', () => {
    /* 按行号取句会把整段算作一行，永远看不到换句（T-04）；key 与「上一句」都是 React 的 props，
       进不了 DOM，这里只能断言印出来的是切到句号之后的那一句。 */
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), thought('t', '先看看配置。然后读日志')], true),
      new Map(),
    )
    const markup = renderHead(planAt(feed, 1)).innerHTML

    expect(markup).toContain('然后读日志')
    expect(markup).not.toContain('先看看配置。然后读日志')
  })

  it('思考里写代码块时，组头停在代码块前最后一句人话上', () => {
    const feed = selectPresentation(
      stateOf([ask(), tool('r', 'read', 'in_progress'), thought('t', '先看看配置。\n```ts\nconst a = 1\n```')], true),
      new Map(),
    )
    const markup = renderHead(planAt(feed, 1)).innerHTML

    expect(markup).toContain('先看看配置。')
    expect(markup).not.toContain('const a = 1')
    expect(markup).not.toContain('```')
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

    /* 量度归阅读栏：flow-row.css 的 [data-measure="prose"] 把量度放开到整列，那一列与输入框
       同宽（都由 --cp-grid 解出），不收在工具那一档的 38rem 上。 */
    expect(markup).toContain('data-measure="prose"')
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
    expect(markup).toContain('读取 1 个文件，运行 1 条命令')
    expect(markup).toContain('data-scrollable')
    /* 两端那道雾：首帧没量过时是 none（不画雾），量过之后按 scrollTop 换。 */
    expect(markup).toContain('data-scroll-mask="none"')
  })
})

describe('分族：图标、文案、分组同一个答案', () => {
  const ids = (feed: Presentation, index: number) => planAt(feed, index).tools.map((row) => row.item.id)

  it('读记忆不进过程组：它自己一行，后面的阅读另起一组', () => {
    const feed = selectPresentation(
      stateOf([
        ask(),
        tool('s', 'search'),
        tool('m', 'read', 'completed', 'read', 'memory'),
        tool('a', 'read'),
        tool('b', 'read'),
      ]),
      new Map(),
    )

    expect(feed.count).toBe(4)
    expect(feed.groupAt(1)).toBeUndefined()
    expect(feed.rowAt(1)?.item.id).toBe('s')
    expect(feed.groupAt(2)).toBeUndefined()
    expect(feed.rowAt(2)?.item.id).toBe('m')
    expect(planAt(feed, 3).kind).toBe('process')
    expect(ids(feed, 3)).toEqual(['a', 'b'])
  })

  it('阅读、代码搜索、运行命令（含 python / js）并成一条过程，组头分笔计数', () => {
    const feed = selectPresentation(
      stateOf([
        ask(),
        tool('r', 'read'),
        tool('g', 'search'),
        tool('f', 'search', 'completed', 'glob'),
        tool('b', 'execute'),
        tool('p', 'execute', 'completed', 'python'),
      ]),
      new Map(),
    )

    expect(feed.count).toBe(2)

    const plan = planAt(feed, 1)

    expect(plan.kind).toBe('process')
    expect(ids(feed, 1)).toEqual(['r', 'g', 'f', 'b', 'p'])
    expect(
      renderToStaticMarkup(<ToolGroupCard isOpen={false} onToggle={nothing} plan={plan} renderRow={() => null} />),
    ).toContain('读取 1 个文件，搜索 2 次，运行 2 条命令')
  })

  it('网络搜索不算「搜索」：它与读网页同族，不进过程组', () => {
    const feed = selectPresentation(
      stateOf([
        ask(),
        tool('g', 'search'),
        tool('w', 'fetch', 'completed', 'web_search'),
        tool('f', 'fetch'),
        tool('h', 'fetch', 'completed', 'read', 'https'),
      ]),
      new Map(),
    )

    expect(feed.count).toBe(3)
    expect(feed.groupAt(1)).toBeUndefined()
    expect(planAt(feed, 2).family).toBe('web')
    expect(ids(feed, 2)).toEqual(['w', 'f', 'h'])
  })

  it('强相关的工具同族：记忆一族、编辑与写入、同一个 MCP 服务', () => {
    const memory = selectPresentation(
      stateOf([ask(), tool('m', 'read', 'completed', 'read', 'memory'), tool('c', 'search', 'completed', 'recall')]),
      new Map(),
    )

    expect(planAt(memory, 1).family).toBe('memory')
    expect(ids(memory, 1)).toEqual(['m', 'c'])

    const edits = selectPresentation(stateOf([ask(), tool('e', 'edit'), tool('w', 'write')]), new Map())

    expect(planAt(edits, 1).family).toBe('edit')
    expect(ids(edits, 1)).toEqual(['e', 'w'])

    const mcp = selectPresentation(
      stateOf([
        ask(),
        tool('a', 'other', 'completed', 'mcp__linear__list'),
        tool('b', 'other', 'completed', 'mcp__linear__get'),
        tool('c', 'other', 'completed', 'mcp__figma__get'),
      ]),
      new Map(),
    )

    expect(mcp.count).toBe(3)
    expect(ids(mcp, 1)).toEqual(['a', 'b'])
    expect(mcp.groupAt(2)).toBeUndefined()
  })

  it('其余工具只与同一个工具成组', () => {
    const feed = selectPresentation(
      stateOf([
        ask(),
        tool('a', 'other', 'completed', 'wait'),
        tool('b', 'other', 'completed', 'wait'),
        tool('c', 'other', 'completed', 'ask'),
      ]),
      new Map(),
    )

    expect(feed.count).toBe(3)
    expect(ids(feed, 1)).toEqual(['a', 'b'])
    expect(feed.groupAt(2)).toBeUndefined()
  })
})

describe('过程组的账目与成员列表', () => {
  it('按族里各笔分开数，顺序固定为阅读、搜索、运行命令，没有的那笔不说', () => {
    const read = tool('r', 'read')
    const grep = tool('g', 'search')
    const bash = tool('b', 'execute')

    expect(sayFamilySummary([read])).toBe('读取 1 个文件')
    expect(sayFamilySummary([bash])).toBe('运行 1 条命令')
    expect(sayFamilySummary([bash, grep, read, read])).toBe('读取 2 个文件，搜索 1 次，运行 1 条命令')
  })

  it('其他族的账目按工具说，不再借「阅读 / 搜索」的说法', () => {
    expect(
      sayFamilySummary([tool('m', 'read', 'completed', 'read', 'memory'), tool('c', 'search', 'completed', 'recall')]),
    ).toBe('读取 1 条记忆，回忆 1 次')
    expect(
      sayFamilySummary([tool('w', 'fetch', 'completed', 'web_search'), tool('f', 'fetch'), tool('h', 'fetch')]),
    ).toBe('搜索网络 1 次，抓取 2 个网页')
    expect(sayFamilySummary([tool('e', 'edit'), tool('f', 'edit')])).toBe('编辑 2 处')
    expect(sayFamilySummary([tool('a', 'other', 'completed', 'wait'), tool('b', 'other', 'completed', 'wait')])).toBe(
      '调用 2 次工具',
    )
  })
})
