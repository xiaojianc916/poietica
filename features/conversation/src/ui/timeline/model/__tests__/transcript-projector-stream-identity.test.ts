import { expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptOperation } from '@poietica/transcript'
import type { TranscriptPage } from '../../../shared/model/transcript'
import { toToolCallFacets } from '../../../shared/semantics/tool-call-facets'
import type { ToolCallTimelineItem } from '../../../shared/timeline/timeline-contract'
import { type ProjectionMemo, projectTranscript } from '../transcript-projector'

/*
 * 同一 step 里既有落定的工具帧、又有正在流的帧时（例如工具之后紧跟的正文；引擎按消息切段后少见，但合法）：
 * 每吐一个字那个 step 就换新对象。已经落定的工具帧引用没变，投影出来的条目也必须是同一个 —— 否则 diff 面板
 * 每批重算、着色从头再来，屏幕上就是「一闪一闪」。
 */

const AT = '2026-10-10T00:00:00.000Z'
const TURN = 's-t1'
const STEP = `${TURN}:s0`

const thinking = (text: string) =>
  ({
    op: 'frame.upsert',
    turnId: TURN,
    stepId: STEP,
    frame: { kind: 'thinking', frameId: `${STEP}:f1`, text },
  }) as unknown as TranscriptOperation

function running(): ReturnType<typeof emptyTimeline> {
  return applyOps(emptyTimeline(), [
    {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId: TURN,
        ordinal: 1,
        state: 'running',
        origin: { kind: 'user' },
        prompt: '改一下',
        startedAt: AT,
      },
    },
    {
      op: 'step.upsert',
      turnId: TURN,
      step: { kind: 'step', stepId: STEP, turnId: TURN, ordinal: 0, state: 'running', startedAt: AT },
    },
    {
      op: 'frame.upsert',
      turnId: TURN,
      stepId: STEP,
      frame: {
        kind: 'tool',
        frameId: `${STEP}:f0`,
        toolCallId: 'call-1',
        name: 'edit',
        state: 'done',
        input: { path: 'src/a.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' },
        output: 'ok',
      },
    },
    thinking('想'),
  ] as unknown as TranscriptOperation[])
}

const pageOf = (state: ReturnType<typeof emptyTimeline>): TranscriptPage =>
  ({
    ...state,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
  }) as unknown as TranscriptPage

const memo = (): ProjectionMemo => ({ sealed: [], outline: [] })

function toolOf(state: ReturnType<typeof emptyTimeline>, m: ProjectionMemo): ToolCallTimelineItem {
  const projected = projectTranscript(pageOf(state), m)
  const items = [...projected.sealed, ...(projected.active === null ? [] : [projected.active])].flatMap((page) =>
    'items' in page ? page.items : [],
  )
  const tool = items.find((item): item is ToolCallTimelineItem => item.type === 'tool_call')
  if (tool === undefined) throw new Error('没投影出工具条目')
  return tool
}

test('S1 思考流式：同一 step 里已落定的工具条目与它的 diff 保持同一引用', () => {
  const m = memo()
  let state = running()
  const first = toolOf(state, m)
  const firstDiff = toToolCallFacets(first).diffs[0]
  expect(firstDiff).toBeDefined()

  for (const text of ['想一', '想一想', '想一想再改']) {
    state = applyOps(state, [thinking(text)])
    const again = toolOf(state, m)
    expect(again).toBe(first)
    expect(toToolCallFacets(again).diffs[0]).toBe(firstDiff)
  }
})

test('S2 工具帧本身换了（产出到了）：条目跟着换', () => {
  const m = memo()
  const state = running()
  const first = toolOf(state, m)
  const next = applyOps(state, [
    {
      op: 'frame.upsert',
      turnId: TURN,
      stepId: STEP,
      frame: {
        kind: 'tool',
        frameId: `${STEP}:f0`,
        toolCallId: 'call-1',
        name: 'edit',
        state: 'done',
        input: { path: 'src/a.ts', oldText: 'const a = 1\n', newText: 'const a = 3\n' },
        output: 'ok',
      },
    } as unknown as TranscriptOperation,
  ])
  expect(toolOf(next, m)).not.toBe(first)
})
