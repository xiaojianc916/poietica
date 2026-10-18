import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState } from '@poietica/transcript'
import { lastTurnOrdinal, projectHistoryPage } from '../history'
import { LiveProjector } from '../live'
import { GOAL_CONTINUATION_ORIGIN } from '../origin'

import {
  assistant,
  assistantTexts,
  prompts,
  T0,
  toolCall,
  toolFrames,
  toolResult,
  toolText,
  user,
} from './fixtures/history'

const iso = (offset: number): string => new Date(T0 + offset).toISOString()

describe('projectHistoryPage', () => {
  test('一轮从人话开始，助手各占一段，工具结果并回发起它的那次调用', () => {
    const page = projectHistoryPage(
      [
        user('问题', 0),
        assistant('先看看', 10),
        toolCall('c1', 'read', { path: 'a.ts' }, 20),
        toolResult('c1', '文件内容'),
        assistant('答案是 42', 30),
      ],
      null,
    )
    expect(page.items.length).toBe(1)
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.prompt).toBe('问题')
    expect(turn?.kind === 'turn' && turn.state).toBe('completed')
    expect(assistantTexts(page)).toEqual(['先看看', '答案是 42'])
    const tools =
      turn?.kind === 'turn'
        ? turn.steps.flatMap((s) => s.frames.flatMap((f) => (f.kind === 'tool' ? [`${f.name}:${f.state}`] : [])))
        : []
    expect(tools).toEqual(['read:done'])
  })

  test('多条人话分成多轮，时间取自真实的一对', () => {
    const page = projectHistoryPage([user('一', 0), assistant('答一', 10), user('二', 20), assistant('答二', 30)], null)
    expect(page.items.length).toBe(2)
    const first = page.items[0]
    expect(first?.kind === 'turn' && first.startedAt).toBe(iso(0))
    expect(first?.kind === 'turn' && first.endedAt).toBe(iso(10))
  })

  test('display: false 的合成横幅不上屏', () => {
    const page = projectHistoryPage(
      [{ role: 'custom', timestamp: T0, content: '目标上下文', display: false }, user('问题', 10), assistant('答', 20)],
      null,
    )
    expect(page.items.length).toBe(1)
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.prompt).toBe('问题')
  })

  test('beforeTurnId 翻页：只剩更早的轮，hasMoreOlder 反映是否还有更早的', () => {
    const messages = [
      user('一', 0),
      assistant('a', 1),
      user('二', 10),
      assistant('b', 11),
      user('三', 20),
      assistant('c', 21),
    ]
    const all = projectHistoryPage(messages, null)
    expect(all.items.length).toBe(3)
    expect(all.hasMoreOlder).toBe(false)
    const older = projectHistoryPage(messages, 't3', { pageSize: 1 })
    expect(older.items.length).toBe(1)
    expect(older.hasMoreOlder).toBe(true)
    const turn = older.items[0]
    expect(turn?.kind === 'turn' && turn.prompt).toBe('二')
  })

  test('isTurnOpen 时最后一轮留 running 且没有终点', () => {
    const page = projectHistoryPage([user('一', 0), assistant('a', 1), user('二', 10)], null, { isTurnOpen: true })
    const last = page.items.at(-1)
    expect(last?.kind === 'turn' && last.state).toBe('running')
    expect(last?.kind === 'turn' && last.endedAt).toBeUndefined()
  })

  test('工具出错时 state 为 error 且带上 error 文本', () => {
    const page = projectHistoryPage(
      [user('一', 0), toolCall('c1', 'bash', {}, 1), toolResult('c1', '炸了', true)],
      null,
    )
    const frames = page.items[0]?.kind === 'turn' ? page.items[0].steps.flatMap((s) => s.frames) : []
    const tool = frames.find((f) => f.kind === 'tool')
    expect(tool?.kind === 'tool' && tool.state).toBe('error')
    expect(tool?.kind === 'tool' && tool.error).toBe('炸了')
  })

  /*
   * 审查 R-21-1：压缩之后前文消失。分页读的是显示经过（压缩前的对话都在，摘要在它发生的位置），
   * 压缩挂在当时开着的那一轮后面、不开轮 —— 轮号与增量那条路一致，中途压缩之后的段仍在这一轮里。
   */
  test('显示经过里的压缩：前文都在、轮号连续，压缩挂在它发生时那一轮后面', () => {
    const page = projectHistoryPage(
      [
        user('第一问', 0),
        assistant('第一答', 10),
        user('第二问', 20),
        toolCall('c1', 'read', { path: 'a.ts' }, 30),
        toolResult('c1', '内容'),
        {
          role: 'compactionSummary',
          timestamp: T0 + 40,
          summary: '整份摘要',
          shortSummary: '短摘要',
          tokensBefore: 120_000,
          tokensAfter: 18_000,
          method: 'context-full',
        },
        assistant('压完接着答', 50),
        user('第三问', 60),
        assistant('第三答', 70),
      ],
      null,
    )
    expect(prompts(page)).toEqual(['第一问', '第二问', '第三问'])
    expect(page.items.map((item) => (item.kind === 'turn' ? item.turnId : item.kind))).toEqual([
      't1',
      't2',
      'marker',
      't3',
    ])
    // 压缩之后的那一段仍归第二轮，没有被吞进一格看不见正文的「压缩轮」
    expect(assistantTexts(page)).toEqual(['第一答', '压完接着答', '第三答'])
    const marker = page.items.find((item) => item.kind === 'marker')
    expect(marker).toMatchObject({
      markerId: 'compaction-2-1',
      marker: 'compaction',
      at: iso(40),
      payload: {
        state: 'completed',
        summary: '整份摘要',
        shortSummary: '短摘要',
        tokensBefore: 120_000,
        tokensAfter: 18_000,
        method: 'context-full',
      },
    })
    expect(lastTurnOrdinal([user('一', 0), { role: 'compactionSummary', timestamp: T0 + 1 }, user('二', 2)])).toBe(2)
  })

  test('审查 R-21-2：最新一轮还开着时，落了盘的压缩也是 completed（不再停在 running）', () => {
    const page = projectHistoryPage(
      [user('问', 0), assistant('答', 10), { role: 'compactionSummary', timestamp: T0 + 20, summary: '摘要' }],
      null,
      { isTurnOpen: true },
    )
    const marker = page.items.find((item) => item.kind === 'marker')
    expect(marker?.kind === 'marker' && marker.payload).toMatchObject({ state: 'completed' })
    expect(page.items.find((item) => item.kind === 'turn')).toMatchObject({ turnId: 't1', state: 'running' })
  })

  test('被后一次压缩取代的摘要只剩占位：标 superseded，不当摘要摆出来', () => {
    const page = projectHistoryPage(
      [
        user('问', 0),
        {
          role: 'compactionSummary',
          timestamp: T0 + 10,
          summary: '[Superseded compaction summary elided after a newer compaction]',
          shortSummary: 'Superseded compaction elided',
          tokensBefore: 100,
        },
      ],
      null,
    )
    const marker = page.items.find((item) => item.kind === 'marker')
    const payload = marker?.kind === 'marker' ? marker.payload : undefined
    expect(payload).toMatchObject({ state: 'completed', superseded: true, tokensBefore: 100 })
    expect(payload).not.toHaveProperty('summary')
    expect(payload).not.toHaveProperty('shortSummary')
  })

  test('同一轮里压两次：两行，各有各的号', () => {
    const page = projectHistoryPage(
      [
        user('问', 0),
        { role: 'compactionSummary', timestamp: T0 + 10, summary: '一' },
        assistant('答', 20),
        { role: 'compactionSummary', timestamp: T0 + 30, summary: '二' },
      ],
      null,
    )
    expect(page.items.flatMap((item) => (item.kind === 'marker' ? [item.markerId] : []))).toEqual([
      'compaction-1-1',
      'compaction-1-2',
    ])
  })

  test('第一句人话之前的压缩只跟着最早那一页走', () => {
    const messages = [
      { role: 'compactionSummary', timestamp: T0, summary: '最早' },
      ...Array.from({ length: 3 }, (_, index) => [
        user(`问${index}`, index * 10 + 1),
        assistant('答', index * 10 + 2),
      ]).flat(),
    ]
    const latest = projectHistoryPage(messages, null, { pageSize: 2 })
    expect(latest.items.some((item) => item.kind === 'marker')).toBe(false)
    expect(latest.hasMoreOlder).toBe(true)
    const older = projectHistoryPage(messages, 't2', { pageSize: 2 })
    expect(older.items.map((item) => (item.kind === 'turn' ? item.turnId : item.kind))).toEqual(['marker', 't1'])
  })

  test('封了口的轮里没有结果的调用不上屏；开着的那一轮里的留着（正在跑）', () => {
    const messages = [
      user('一', 0),
      toolCall('dead', 'bash', { command: 'x' }, 10),
      assistant('换个办法', 20),
      user('二', 30),
      toolCall('live', 'bash', { command: 'y' }, 40),
    ]
    const sealed = projectHistoryPage(messages, null)
    const open = projectHistoryPage(messages, null, { isTurnOpen: true })
    const callsOf = (page: ReturnType<typeof projectHistoryPage>) =>
      page.items.flatMap((item) =>
        item.kind === 'turn'
          ? item.steps.flatMap((step) =>
              step.frames.flatMap((f) => (f.kind === 'tool' ? [`${item.turnId}:${f.toolCallId}`] : [])),
            )
          : [],
      )
    expect(callsOf(sealed)).toEqual([])
    expect(callsOf(open)).toEqual(['t2:live'])
    // 剥掉调用后不留一个空段
    const first = sealed.items.find((item) => item.kind === 'turn' && item.turnId === 't1')
    expect(first?.kind === 'turn' && first.steps.length).toBe(1)
  })

  test('lastTurnOrdinal 给出最后一轮的号', () => {
    expect(lastTurnOrdinal([user('一', 0), assistant('a', 1)])).toBe(1)
    expect(lastTurnOrdinal([])).toBe(0)
  })

  test('目标续跑那一条自开一轮：来源 goal_continuation、不带人话（审查 R-11）', () => {
    const page = projectHistoryPage(
      [
        user('把测试迁完', 0),
        assistant('第一轮', 10),
        {
          role: 'custom',
          customType: 'goal-continuation',
          timestamp: T0 + 20,
          content: '继续推进目标',
          display: false,
        },
        assistant('第二轮', 30),
      ],
      null,
    )
    expect(page.items.length).toBe(2)
    const second = page.items[1]
    expect(second?.kind === 'turn' && second.origin).toEqual(GOAL_CONTINUATION_ORIGIN)
    expect(second?.kind === 'turn' && second.prompt).toBeUndefined()
    expect(assistantTexts(page)).toEqual(['第一轮', '第二轮'])
  })

  test('轮的终点取「答完那一刻」，不是请求发起那一刻', () => {
    const page = projectHistoryPage(
      [
        user('你好', 0),
        {
          role: 'assistant',
          timestamp: T0 + 144,
          duration: 1_450,
          completedAt: T0 + 1_594,
          content: [{ type: 'text', text: '你好' }],
        },
      ],
      null,
    )
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.endedAt).toBe(iso(1_594))
    expect(turn?.kind === 'turn' && turn.steps[0]?.endedAt).toBe(iso(1_594))
  })

  test('只有 duration 时用 timestamp + duration 兜底', () => {
    const page = projectHistoryPage(
      [user('问', 0), { role: 'assistant', timestamp: T0 + 10, duration: 990, content: '答' }],
      null,
    )
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.endedAt).toBe(iso(1_000))
  })

  test('快轮不再算成 <1秒：144 毫秒的段也按真实 1594 毫秒收', () => {
    const page = projectHistoryPage(
      [user('你好', 0), { role: 'assistant', timestamp: T0 + 144, completedAt: T0 + 1_594, content: '你好' }],
      null,
    )
    const turn = page.items[0]
    const startedAt = turn?.kind === 'turn' ? Date.parse(turn.startedAt ?? '') : Number.NaN
    const endedAt = turn?.kind === 'turn' ? Date.parse(turn.endedAt ?? '') : Number.NaN
    expect(endedAt - startedAt).toBeGreaterThan(1_000)
  })
})

describe('历史与实时的一致性', () => {
  test('同一轮：实时投影与历史投影的文本、工具结果一致', () => {
    const p = new LiveProjector({ now: () => T0 })
    const liveOps = [
      ...p.userTurn({ text: '问题' }),
      ...p.textDelta('先看看'),
      ...p.toolStart({ toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } }),
      ...p.toolEnd({
        toolCallId: 'c1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: '文件内容' }], details: {} },
      }),
      ...p.textDelta('答案是 42'),
      ...p.turnEnd('completed', null),
    ]
    const live = projectHistoryPage([], null)
    void live
    const livePage = pageFromState(applyOps(emptyTimeline(), liveOps))
    const history = projectHistoryPage(
      [
        user('问题', 0),
        assistant('先看看', 10),
        toolCall('c1', 'read', { path: 'a.ts' }, 20),
        toolResult('c1', '文件内容'),
        assistant('答案是 42', 30),
      ],
      null,
    )
    const liveTexts = livePage.items.flatMap((item) =>
      item.kind === 'turn'
        ? item.steps.flatMap((s) =>
            s.frames.flatMap((f) => (f.kind === 'text' && f.role === 'assistant' ? [f.text] : [])),
          )
        : [],
    )
    const liveTools = livePage.items.flatMap((item) =>
      item.kind === 'turn'
        ? item.steps.flatMap((s) =>
            s.frames.flatMap((f) => (f.kind === 'tool' ? [`${f.name}:${toolText(f.output)}`] : [])),
          )
        : [],
    )
    expect(liveTexts).toEqual(assistantTexts(history))
    expect(liveTools).toEqual(toolFrames(history))
    expect(prompts(livePage)).toEqual(prompts(history))
  })
})
