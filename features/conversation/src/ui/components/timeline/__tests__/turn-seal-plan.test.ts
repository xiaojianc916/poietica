import { describe, expect, it } from 'bun:test'
import { selectPresentation } from '../../../timeline/presentation'
import type {
  TimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  TurnOutcome,
} from '../../../timeline/timeline-contract'

/*
 * 「什么时候封 / 什么时候不封」的判据全在投影这一层（DSH 的 canCollapse / alwaysOpen / foldable）。
 * 三条不封：**在跑**（还没完）、**被人叫停**、**自己坏了** —— 后两条要让人看见过程与它坏在哪。
 * 正常答完的才封，且封条自己变成那个可点的开关。
 */

function ask(id = 'ask'): TimelineItem {
  return { type: 'user_message', id, turn: 0, at: 0, text: '帮我看一下' }
}

function said(id = 'a'): TimelineItem {
  return { type: 'agent_text', id, turn: 0, at: 2, text: '看完了。', sealed: true }
}

/** read 那一档的工具，够用来凑出「有过程可折」。 */
function toolCall(id: string, invokedTool: string, kind: ToolCallTimelineItem['kind']): ToolCallTimelineItem {
  return {
    type: 'tool_call',
    id,
    turn: 0,
    at: 1,
    toolCallId: `call-${id}`,
    title: invokedTool,
    invokedTool,
    scheme: '',
    kind,
    headline: '',
    subject: '',
    shape: 'flow',
    status: 'completed',
    requestContent: [],
    content: [],
    locations: [],
    channels: [],
    startedAt: 0,
    endedAt: 1,
  }
}

/** 一轮：提问 → 读一个文件（过程）→ 答复。过程与答复都在，才谈得上折叠。 */
function items(): TimelineItem[] {
  return [ask(), toolCall('r', 'read', 'read'), said()]
}

function stateOf(
  outcome: TurnOutcome | undefined,
  running: boolean,
  list: readonly TimelineItem[] = items(),
): TimelineState {
  const active: TimelineState['active'] = {
    turn: 0,
    ...(running || outcome !== undefined
      ? { run: { settled: !running, undoCount: null, forkUnavailableReason: null } }
      : {}),
    ...(outcome === undefined ? {} : { outcome }),
    items: list,
  }

  return {
    status: running ? 'running' : 'idle',
    backgroundTasks: [],
    subagents: [],
    sealed: [],
    active,
    lastSeq: 0,
    spans: [],
  }
}

/** 封条挂在哪一行上（找不到就是这一轮没有封条）。 */
function sealIndex(state: TimelineState): number | undefined {
  const feed = selectPresentation(state, new Map())

  for (let index = 0; index < feed.count; index += 1) {
    if (feed.sealAt(index) !== undefined) {
      return index
    }
  }

  return undefined
}

function sealOf(
  state: TimelineState,
): NonNullable<ReturnType<ReturnType<typeof selectPresentation>['sealAt']>> | undefined {
  const at = sealIndex(state)

  return at === undefined ? undefined : selectPresentation(state, new Map()).sealAt(at)
}

describe('什么时候这一轮没有封条', () => {
  it('还没有运行事实（没有 run 字段）：整条不画', () => {
    const bare: TimelineState = {
      status: 'idle',
      backgroundTasks: [],
      subagents: [],
      sealed: [],
      active: { turn: 0, items: items() },
      lastSeq: 0,
      spans: [],
    }

    expect(sealIndex(bare)).toBeUndefined()
  })
})

describe('封条的折叠判据（canCollapse）', () => {
  it('还在跑：压根没有封条 —— 那一句由转录末尾的运行状态行说', () => {
    expect(sealIndex(stateOf(undefined, true))).toBeUndefined()
  })

  it('正常答完且有过程：可折叠，且默认收起（过程折进去）', () => {
    const seal = sealOf(stateOf('completed', false))

    expect(seal?.canCollapse).toBe(true)
    expect(seal?.isOpen).toBe(false)
  })

  it('被人叫停：摊开、不可折叠，让人看见停在哪', () => {
    const seal = sealOf(stateOf('aborted', false))

    expect(seal?.outcome).toBe('aborted')
    expect(seal?.isOpen).toBe(true)
    expect(seal?.canCollapse).toBe(false)
  })

  it('自己坏了：同样摊开、不可折叠', () => {
    const seal = sealOf(stateOf('error', false))

    expect(seal?.outcome).toBe('error')
    expect(seal?.isOpen).toBe(true)
    expect(seal?.canCollapse).toBe(false)
  })

  it('没有过程可折（只有提问与答复）：不画开关', () => {
    const seal = sealOf(stateOf('completed', false, [ask(), said()]))

    expect(seal?.hasProcess).toBe(false)
    expect(seal?.canCollapse).toBe(false)
  })

  it('在跑但还没有产出：同样没有封条', () => {
    expect(sealIndex(stateOf(undefined, true, [ask()]))).toBeUndefined()
  })
})

describe('过程折起来时屏幕上少了什么', () => {
  it('落定且收起：过程那一条不进投影（封条替它说话）', () => {
    const feed = selectPresentation(stateOf('completed', false), new Map())
    const ids: string[] = []

    for (let index = 0; index < feed.count; index += 1) {
      const row = feed.rowAt(index)
      if (row !== undefined) ids.push(row.item.id)
    }

    expect(ids).not.toContain('r')
  })

  it('被人叫停：过程留在屏幕上，不折', () => {
    const feed = selectPresentation(stateOf('aborted', false), new Map())
    const ids: string[] = []

    for (let index = 0; index < feed.count; index += 1) {
      const row = feed.rowAt(index)
      if (row !== undefined) ids.push(row.item.id)
    }

    expect(ids).toContain('r')
  })
})

describe('运行状态行的判据', () => {
  it('在跑时才有它，起始时刻来自这一轮的段', () => {
    const state = stateOf(undefined, true)
    const withSpan: TimelineState = { ...state, spans: [{ turn: 0, startedAt: 1_000 }] }
    const feed = selectPresentation(withSpan, new Map())

    expect(feed.running?.startedAt).toBe(1_000)
  })

  it('没在跑就没有它', () => {
    expect(selectPresentation(stateOf('completed', false), new Map()).running).toBeUndefined()
  })

  it('上面紧挨着我自己的话时不画分隔线：那一格本来就是「我说完了，它开始动」', () => {
    const feed = selectPresentation(stateOf(undefined, true, [ask()]), new Map())

    expect(feed.running?.divided).toBe(false)
  })

  it('上面是它的产出时画分隔线', () => {
    const feed = selectPresentation(stateOf(undefined, true, [ask(), toolCall('r', 'read', 'read')]), new Map())

    expect(feed.running?.divided).toBe(true)
  })

  it('上面是它说的一段话时也画：与我自己的气泡是两回事', () => {
    const feed = selectPresentation(stateOf(undefined, true, [ask(), said()]), new Map())

    expect(feed.running?.divided).toBe(true)
  })

  it('它上面什么都没有时不画：还没有东西可分隔', () => {
    const feed = selectPresentation(stateOf(undefined, true, []), new Map())

    expect(feed.running?.divided).toBe(false)
  })

  it('段里没有起始时刻：照样有这一行，只是报不出时长', () => {
    const feed = selectPresentation(stateOf(undefined, true), new Map())

    expect(feed.running).toBeDefined()
    expect(feed.running?.startedAt).toBeUndefined()
  })
})
