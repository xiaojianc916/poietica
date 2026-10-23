import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { outlineOf, type ProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 投影的「引用稳定化」必须按通道各记各的。
 *
 * presentation 层以 `sealed` 数组为键缓存整段前缀，minimap 以 `outline` 数组为键做 memo。
 * 主对话、每个子代理、后台在跑的每条对话都调同一个 `projectTranscript` / `outlineOf`：
 * 若只有一个模块级槽位，两条通道交替发布就会互相覆盖，前台那条每批都换新数组。
 */

const AT = '2026-10-10T00:00:00.000Z'

function turnOps(tag: string, ordinal: number, running: boolean): unknown[] {
  const turnId = `${tag}-t${ordinal}`
  const stepId = `${turnId}:s0`
  const state = running ? 'running' : 'completed'
  const ended = running ? {} : { endedAt: AT }
  return [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal,
        state,
        origin: { kind: 'user' },
        prompt: `问 ${ordinal}`,
        startedAt: AT,
        ...ended,
      },
    },
    {
      op: 'step.upsert',
      turnId,
      step: { kind: 'step', stepId, turnId, ordinal: 0, state, startedAt: AT, ...ended },
    },
    {
      op: 'frame.upsert',
      turnId,
      stepId,
      frame: { kind: 'text', frameId: `${stepId}:f0`, role: 'assistant', text: `答 ${ordinal}` },
    },
  ]
}

/** 一条通道：settled 轮已封口，最后再跟一轮在跑的。 */
function channel(tag: string, settled: number): ReturnType<typeof emptyTimeline> {
  const ops: unknown[] = []
  for (let ordinal = 1; ordinal <= settled; ordinal += 1) ops.push(...turnOps(tag, ordinal, false))
  ops.push(...turnOps(tag, settled + 1, true))
  return applyOps(emptyTimeline(), ops as TranscriptOperation[])
}

/** 在跑那一轮再吐一个字：上游结构共享，只有那一轮换新对象。 */
function streamed(state: ReturnType<typeof emptyTimeline>, tag: string, settled: number, text: string) {
  const turnId = `${tag}-t${settled + 1}`
  const stepId = `${turnId}:s0`
  return applyOps(state, [
    { op: 'frame.upsert', turnId, stepId, frame: { kind: 'text', frameId: `${stepId}:f0`, role: 'assistant', text } },
  ] as unknown as TranscriptOperation[])
}

function pageOf(state: ReturnType<typeof emptyTimeline>): TranscriptPage {
  return {
    ...state,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
    agentId: 'main',
    agents: [],
    pendingInteractions: [],
    seq: 1,
  } as unknown as TranscriptPage
}

/*
 * 每条通道一份备忘录（生产代码里由 TranscriptStore 按副本 + agentId 持有）。
 * 这里用字面量造而不用 createProjectionMemo：这样这份测试在旧代码上也跑得起来，红在断言上。
 */
const memo = (): ProjectionMemo => ({ sealed: [], outline: [] })

test('M1 两条通道交替投影：A 在 B 之后再投，sealed 仍是 A 上一次那个数组', () => {
  const [ma, mb] = [memo(), memo()]
  const a = channel('a', 3)
  const first = projectTranscript(pageOf(a), ma).sealed
  projectTranscript(pageOf(channel('b', 3)), mb)
  const again = projectTranscript(pageOf(streamed(a, 'a', 3, '答 4 多一个字')), ma).sealed

  expect(first.length).toBe(3)
  expect(again).toBe(first)
})

test('M2 两条通道交替：outline 同样各自稳定', () => {
  const [ma, mb] = [memo(), memo()]
  const a = channel('a', 3)
  const first = outlineOf(pageOf(a), ma)
  outlineOf(pageOf(channel('b', 3)), mb)
  const again = outlineOf(pageOf(streamed(a, 'a', 3, '答 4 多一个字')), ma)

  expect(first.length).toBe(4)
  expect(again).toBe(first)
})

test('M3 单通道流式：在跑那一轮每批换新 turn 对象，outline 仍是同一个数组', () => {
  const m = memo()
  let state = channel('s', 2)
  const first = outlineOf(pageOf(state), m)
  for (const text of ['答', '答 3', '答 3 的后半']) {
    state = streamed(state, 's', 2, text)
    expect(outlineOf(pageOf(state), m)).toBe(first)
  }
})

test('M4 那一轮封口：重算一次，拿到完整回复', () => {
  const m = memo()
  const running = streamed(channel('e', 1), 'e', 1, '半截')
  const before = outlineOf(pageOf(running), m)
  const done = applyOps(running, [
    ...(turnOps('e', 2, false).slice(0, 2) as TranscriptOperation[]),
    {
      op: 'frame.upsert',
      turnId: 'e-t2',
      stepId: 'e-t2:s0',
      frame: { kind: 'text', frameId: 'e-t2:s0:f0', role: 'assistant', text: '完整的回复' },
    },
  ] as unknown as TranscriptOperation[])
  const after = outlineOf(pageOf(done), m)

  expect(after).not.toBe(before)
  expect(after.at(-1)?.reply).toBe('完整的回复')
  expect(after[0]).toBe(before[0])
})

test('M5 同号换了题面（reset）：不沿用上一份的标记', () => {
  const m = memo()
  outlineOf(pageOf(channel('r', 0)), m)
  const reset = applyOps(emptyTimeline(), [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: 'r-t1',
        ordinal: 1,
        state: 'running',
        origin: { kind: 'user' },
        prompt: '换了一句',
        startedAt: AT,
      },
    },
  ] as unknown as TranscriptOperation[])

  expect(outlineOf(pageOf(reset), m)[0]?.prompt).toBe('换了一句')
})

test('M6 同一通道又封口一轮：sealed 换新数组、多出一页', () => {
  const m = memo()
  const before = projectTranscript(pageOf(channel('c', 2)), m).sealed
  const after = projectTranscript(pageOf(channel('c', 3)), m).sealed

  expect(after).not.toBe(before)
  expect(after.length).toBe(3)
})

test('M7 只有一轮（没有封口页）：sealed 与 outline 都是空的且不抛', () => {
  expect(projectTranscript(pageOf(channel('d', 0)), memo()).sealed).toEqual([])
  expect(outlineOf(pageOf(applyOps(emptyTimeline(), [])), memo())).toEqual([])
})

/** 带目录的头页：目录列出 1..total 轮，已载入的是 from..total。 */
function pagedOf(tag: string, from: number, total: number): TranscriptPage {
  const ops: unknown[] = []
  for (let ordinal = from; ordinal <= total; ordinal += 1) ops.push(...turnOps(tag, ordinal, false))
  const outline = Array.from({ length: total }, (_, at) => ({
    turnId: `${tag}-t${at + 1}`,
    ordinal: at + 1,
    prompt: `问 ${at + 1}`,
    reply: `答 ${at + 1}`,
  }))
  return { ...pageOf(applyOps(emptyTimeline(), ops as TranscriptOperation[])), hasMoreOlder: from > 1, outline }
}

test('M8 轨道定义域是整条对话：未载入的轮来自目录，已载入的轮来自时间线', () => {
  const page = pagedOf('o', 21, 40)
  const marks = outlineOf(page, memo())

  expect(marks.length).toBe(40)
  expect(marks.map((mark) => mark.turnId).slice(18, 22)).toEqual(['o-t19', 'o-t20', 'o-t21', 'o-t22'])
  expect(marks[0]).toEqual({ turnId: 'o-t1', admissionId: 'o-t1', prompt: '问 1', reply: '答 1' })
})

test('M9 往上翻一页：长度不变，冷前缀与已载入部分的格子沿用同一个对象', () => {
  const m = memo()
  const head = pagedOf('p', 21, 40)
  const before = outlineOf(head, m)
  const after = outlineOf({ ...pagedOf('p', 11, 40), outline: head.outline }, m)

  expect(after.length).toBe(40)
  expect(after[0]).toBe(before[0])
  expect(after[39]).toBe(before[39])
})

test('M10 引擎没给目录：退回只有已载入的轮', () => {
  const page = { ...pagedOf('q', 5, 8), outline: undefined }
  expect(outlineOf(page, memo()).map((mark) => mark.turnId)).toEqual(['q-t5', 'q-t6', 'q-t7', 'q-t8'])
})
