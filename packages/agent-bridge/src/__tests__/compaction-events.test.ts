/*
 * 上下文压缩的桥侧：omp 的两个事件 → 一条稳定的标记。
 *
 * 这是那个缺陷的生产者一半。此前 CompactionStatus 渲染器与投影通路都建好了，而桥的
 * handleEvent 把这两个事件丢进 default: break —— 于是上下文被压缩时屏幕上什么都不说，
 * 人看到的是自己前几句莫名其妙没了。
 *
 * 判据里最重要的一条是「号要稳」：开门与关门共用同一个 markerId。换号会在屏幕上多出
 * 一行，而人读到的会是「上下文被压了两次」这种不存在的历史。
 *
 * 自检跑法：bun test src/__tests__/compaction-events.test.ts
 */

import { expect, test } from 'bun:test'
import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'
import { markerOp } from '../projection.ts'

/** 桥里那一对事件的形状（agent-session-events.ts:19-33）。 */
type Started = { readonly reason: string; readonly action: string }
type Ended = {
  readonly action: string
  readonly result: { readonly tokensBefore?: number } | undefined
  readonly aborted: boolean
  readonly skipped?: boolean
  readonly errorMessage?: string
}

/*
 * 复刻桥里那两个 case 的落点。这里不 import main.ts —— 那个模块一被 import 就会去连
 * 进程与环境；被钉住的判据是「两个事件怎么变成一条标记」，不是「main 怎么启动」。
 */
function produced(events: readonly (Started | Ended)[]): {
  readonly markerIds: string[]
  readonly payloads: Record<string, unknown>[]
} {
  let compacting: string | null = null
  let compactions = 0
  const markerIds: string[] = []
  const payloads: Record<string, unknown>[] = []

  for (const event of events) {
    if ('reason' in event) {
      compactions += 1
      compacting = `compaction-${String(compactions)}`
      markerIds.push(compacting)
      payloads.push({ state: 'running' })

      continue
    }

    const id = compacting ?? `compaction-${String(++compactions)}`
    compacting = null
    markerIds.push(id)

    const tokensBefore = event.result?.tokensBefore
    payloads.push({
      state:
        event.aborted || event.skipped === true || event.errorMessage !== undefined
          ? 'cancelled'
          : 'completed',
      ...(typeof tokensBefore === 'number' ? { tokensBefore } : {}),
    })
  }

  return { markerIds, payloads }
}

/** 把标记真正喂进 transcript，确认它落成一行且只有一行。 */
function rowsOf(ids: readonly string[], payloads: readonly Record<string, unknown>[]) {
  let state = EMPTY_AGENT_STATE

  for (const [index, id] of ids.entries()) {
    // markerOp 与 interactionOp 同形：一次 upsert 交回一批 op。
    for (const op of markerOp({ markerId: id, marker: 'compaction', payload: payloads[index] })) {
      state = applyOperation(state, op).state
    }
  }

  return state.items.filter((item) => item.kind === 'marker' && item.marker === 'compaction')
}

const started: Started = { reason: 'threshold', action: 'context-full' }

test('开门与关门是同一条标记，不是两条', () => {
  const { markerIds } = produced([
    started,
    { action: 'context-full', result: { tokensBefore: 120_000 }, aborted: false },
  ])

  // 换号就会在屏幕上多出一行；这里钉的是「号认得出是一件事」。
  expect(markerIds).toEqual(['compaction-1', 'compaction-1'])
  expect(
    rowsOf(
      markerIds,
      produced([
        started,
        { action: 'context-full', result: { tokensBefore: 120_000 }, aborted: false },
      ]).payloads,
    ),
  ).toHaveLength(1)
})

test('第二次压缩另起一行', () => {
  const events = [
    started,
    { action: 'context-full' as const, result: undefined, aborted: false },
    started,
    { action: 'context-full' as const, result: undefined, aborted: false },
  ]
  const { markerIds, payloads } = produced(events)

  expect(markerIds).toEqual(['compaction-1', 'compaction-1', 'compaction-2', 'compaction-2'])
  expect(rowsOf(markerIds, payloads)).toHaveLength(2)
})

test('没成的压缩不能说成完成', () => {
  const cases: Ended[] = [
    // 中止：人按了取消，这次没有结果。
    { action: 'context-full', result: undefined, aborted: true },
    // 跳过：它压根没动手，报完成就是谎报。
    { action: 'context-full', result: undefined, aborted: false, skipped: true },
    // 出错：同上。
    { action: 'context-full', result: undefined, aborted: false, errorMessage: 'boom' },
  ]

  for (const ended of cases) {
    const { payloads } = produced([started, ended])

    expect(payloads[1]?.['state']).toBe('cancelled')
  }
})

test('成了就是完成', () => {
  const { payloads } = produced([
    started,
    { action: 'context-full', result: { tokensBefore: 90 }, aborted: false },
  ])

  expect(payloads[1]?.['state']).toBe('completed')
})

test('token 数只报 agent 真给了的那一格', () => {
  const withCount = produced([
    started,
    { action: 'context-full', result: { tokensBefore: 90 }, aborted: false },
  ])
  const without = produced([started, { action: 'context-full', result: undefined, aborted: false }])

  // CompactionResult 只有 tokensBefore（compaction.d.ts:21-31），没有 tokensAfter。
  expect(withCount.payloads[1]?.['tokensBefore']).toBe(90)
  expect(withCount.payloads[1]).not.toHaveProperty('tokensAfter')
  // 没给就不编：报 0 会让人以为压缩把上下文清空了。
  expect(without.payloads[1]).not.toHaveProperty('tokensBefore')
  expect(without.payloads[1]).not.toHaveProperty('tokensAfter')
})

test('没有开门的关门事件也留得下痕迹', () => {
  // 中途接上一条已经在压的会话时只有关门那一下；丢掉它就等于这一段历史没发生。
  const { markerIds, payloads } = produced([
    { action: 'context-full', result: undefined, aborted: false },
  ])

  expect(markerIds).toEqual(['compaction-1'])
  expect(payloads[0]?.['state']).toBe('completed')
})
