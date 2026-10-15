import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, pageFromState, type TranscriptPage } from '@poietica/transcript'
import { lastTurnOrdinal, type OmpMessage, projectHistoryPage } from '../history'
import { LiveProjector } from '../live'
import { assistant, prompts, T0, toolCall, toolResult, user } from './fixtures/history'

/*
 * R-23：跑着时送进去的人话（插话 / 排队被同一次运行吃掉）重开之后不能拆成新的一轮。
 * 实时那边它落进当前那一轮、只有一张封条；历史这边必须从落了盘的消息里还原成同一个样子。
 */

const iso = (offset: number): string => new Date(T0 + offset).toISOString()
const done = (message: OmpMessage, completedAt: number): OmpMessage => ({ ...message, completedAt: T0 + completedAt })
const resultAt = (id: string, content: unknown, at: number): OmpMessage => ({
  ...toolResult(id, content),
  timestamp: T0 + at,
})

/** 屏幕上每一轮的形状：人话、轮内依次上屏的帧。实时那条开场用户帧不带 origin、不上屏，不算。 */
function shape(page: TranscriptPage) {
  return page.items.flatMap((item) =>
    item.kind === 'turn'
      ? [
          {
            prompt: item.prompt,
            frames: item.steps.flatMap((s) => s.frames.flatMap(labelOf)),
          },
        ]
      : [],
  )
}

type Frame = Extract<TranscriptPage['items'][number], { kind: 'turn' }>['steps'][number]['frames'][number]

function labelOf(f: Frame): string[] {
  if (f.kind === 'tool') return [`tool:${f.name}`]
  if (f.kind !== 'text') return [f.kind]
  return f.role === 'user' && f.origin === undefined ? [] : [`${f.role}:${f.text}`]
}

/** 上屏的人话帧（带 origin 的那种） */
function userFrames(page: TranscriptPage) {
  return page.items.flatMap((item) =>
    item.kind === 'turn'
      ? item.steps.flatMap((s) =>
          s.frames.flatMap((f) =>
            f.kind === 'text' && f.role === 'user' && f.origin !== undefined
              ? [{ text: f.text, origin: f.origin }]
              : [],
          ),
        )
      : [],
  )
}

/** 截图里那一轮：提问 6 秒后排了一句「快点啊」，1 分 29 秒时同一次运行吃掉它，3 分 2 秒答完 */
const reported: OmpMessage[] = [
  user('你认为最佳做法是什么？', 0),
  done(toolCall('c1', 'bash', { command: 'sed -n 1,9p a.ts' }, 1_000), 3_000),
  resultAt('c1', '源码', 80_000),
  done(assistant('先核对一下', 81_000), 89_000),
  user('快点啊', 6_000),
  done(assistant('一句话：最佳做法是……', 90_000), 182_000),
]

describe('跑着时送进去的人话不开新轮（R-23）', () => {
  test('截图那一轮：排队被同一次运行吃掉的话落进这一轮，只有一轮、时长从提问算到答完', () => {
    const page = projectHistoryPage(reported, null)
    expect(page.items.length).toBe(1)
    expect(prompts(page)).toEqual(['你认为最佳做法是什么？'])
    expect(shape(page)[0]?.frames).toEqual([
      'tool:bash',
      'assistant:先核对一下',
      'user:快点啊',
      'assistant:一句话：最佳做法是……',
    ])
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.startedAt).toBe(iso(0))
    expect(turn?.kind === 'turn' && turn.endedAt).toBe(iso(182_000))
    expect(lastTurnOrdinal(reported)).toBe(1)
  })

  test('插话帧与实时那条同一个形状：role user、origin user', () => {
    expect(userFrames(projectHistoryPage(reported, null))).toEqual([{ text: '快点啊', origin: { kind: 'user' } }])
  })

  test('omp 打了插话标的话即使提交时刻偏晚也归这一轮；工具还在跑时提交的也归这一轮', () => {
    const steered = projectHistoryPage(
      [
        user('问', 0),
        done(toolCall('c1', 'bash', {}, 10), 20),
        resultAt('c1', 'ok', 100),
        { ...user('改个方向', 101), steering: true },
        done(assistant('好的', 110), 120),
      ],
      null,
    )
    expect(steered.items.length).toBe(1)
    const duringTool = projectHistoryPage(
      [
        user('问', 0),
        done(toolCall('c1', 'bash', {}, 10), 20),
        resultAt('c1', 'ok', 100),
        user('别急', 50),
        done(assistant('好的', 110), 120),
      ],
      null,
    )
    expect(duringTool.items.length).toBe(1)
    expect(shape(duringTool)[0]?.frames).toEqual(['tool:bash', 'user:别急', 'assistant:好的'])
  })

  test('上一轮收完之后才发的话照旧开新轮', () => {
    const page = projectHistoryPage(
      [user('一', 0), done(assistant('答一', 10), 20), user('二', 30), assistant('答二', 40)],
      null,
    )
    expect(prompts(page)).toEqual(['一', '二'])
    expect(userFrames(page)).toEqual([])
  })

  test('被叫停 / 出错之后排着的话另起一次运行：即使带插话标、提交得早，也是新的一轮', () => {
    for (const stopReason of ['aborted', 'error']) {
      const page = projectHistoryPage(
        [
          user('一', 0),
          { ...done(assistant('答到一半', 10), 30), stopReason },
          { ...user('二', 20), steering: true },
          assistant('答二', 40),
        ],
        null,
      )
      expect(prompts(page)).toEqual(['一', '二'])
    }
  })

  test('插话带的图挂在那一帧上，号与开轮那句不撞', () => {
    const image = { type: 'image', data: 'QUJD', mimeType: 'image/png' }
    const page = projectHistoryPage(
      [
        { role: 'user', timestamp: T0, content: [{ type: 'text', text: '看图' }, image] },
        done(assistant('在看', 10), 50),
        { role: 'user', timestamp: T0 + 20, content: [{ type: 'text', text: '还有这张' }, image] },
        assistant('好', 60),
      ],
      null,
    )
    const frame = page.items.flatMap((item) =>
      item.kind === 'turn'
        ? item.steps.flatMap((s) => s.frames.filter((f) => f.kind === 'text' && f.role === 'user'))
        : [],
    )[0]
    const ids = frame?.kind === 'text' ? frame.attachmentIds : undefined
    expect(ids?.length).toBe(1)
    expect(page.attachments.map((a) => a.attachmentId)).toEqual([`${iso(0)}#1`, `${iso(20)}#1`])
    expect(ids?.[0]).toBe(`${iso(20)}#1`)
  })

  test('还开着的那一轮：插话之后还没产出时，插话那一段留 running', () => {
    const page = projectHistoryPage([user('问', 0), done(assistant('先看', 10), 30), user('快点', 20)], null, {
      isTurnOpen: true,
    })
    expect(page.items.length).toBe(1)
    const turn = page.items[0]
    expect(turn?.kind === 'turn' && turn.state).toBe('running')
    expect(turn?.kind === 'turn' && turn.steps.at(-1)?.state).toBe('running')
  })
})

describe('实时与重开一致', () => {
  test('同一次运行里插过话：实时投影与历史投影的轮数、人话、帧序一致', () => {
    const p = new LiveProjector({ now: () => T0 })
    const liveOps = [
      ...p.userTurn({ text: '你认为最佳做法是什么？' }),
      ...p.toolStart({ toolCallId: 'c1', toolName: 'bash', args: { command: 'sed -n 1,9p a.ts' } }),
      ...p.toolEnd({
        toolCallId: 'c1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '源码' }], details: {} },
      }),
      ...p.textDelta('先核对一下'),
      ...p.steeredFrame('快点啊'),
      ...p.textDelta('一句话：最佳做法是……'),
      ...p.turnEnd('completed', null),
    ]
    const live = pageFromState(applyOps(emptyTimeline(), liveOps)) as unknown as TranscriptPage
    const history = projectHistoryPage(reported, null)
    expect(shape(history)).toEqual(shape(live))
    expect(userFrames(history)).toEqual(userFrames(live))
  })
})
