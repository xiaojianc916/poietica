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

  test('用户消息里的图片变成附件条目', () => {
    const page = projectHistoryPage(
      [
        {
          role: 'user',
          timestamp: T0,
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        assistant('看到了', 10),
      ],
      null,
    )
    expect(page.attachments.length).toBe(1)
    expect(page.attachments[0]?.mediaType).toBe('image/png')
    expect(page.attachments[0]?.source).toEqual({ kind: 'url', url: 'data:image/png;base64,AAAA' })
  })

  test('压缩那一条铺成 marker', () => {
    const page = projectHistoryPage(
      [{ role: 'compactionSummary', timestamp: T0, summary: '压好了' }, user('问题', 10), assistant('答', 20)],
      null,
    )
    const marker = page.items.find((i) => i.kind === 'marker')
    expect(marker?.kind === 'marker' && marker.marker).toBe('compaction')
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
