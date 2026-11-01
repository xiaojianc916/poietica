import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TimelineState, type TranscriptTurn } from '@poietica/transcript'
import type { LiveProjector } from '../live'
import { projector } from './fixtures/live'

/*
 * 增量那条路按消息 / 工具调用切段，与历史那条路（history.ts 的 emitMessage）同一个口径。
 * 真会话上的逐帧比对在 live-history-parity；这里钉住切段的每一条规矩，以及它要保护的那件事：
 * 流式增量只让正在流的那一段换新对象，已落定的段引用不变（投影层按段身份复用，diff 面板才不闪）。
 */

const turnOf = (state: TimelineState): TranscriptTurn => {
  const turn = state.items.find((item): item is TranscriptTurn => item.kind === 'turn')
  if (turn === undefined) throw new Error('没有轮')
  return turn
}

/** 每段装了哪些帧号 */
const layout = (state: TimelineState): string[][] =>
  turnOf(state).steps.map((step) => step.frames.map((frame) => frame.frameId))

/** 一条助手消息开始（omp 的 message_start）：只挪指针、不产出 op，这里交回空表好摊进同一串 */
const message = (p: LiveProjector): [] => {
  p.assistantMessageStart()
  return []
}

const edit = (p: LiveProjector, id: string) => [
  ...p.toolStart({ toolCallId: id, toolName: 'edit', args: { path: 'a.ts' } }),
  ...p.toolEnd({ toolCallId: id, toolName: 'edit', result: { content: [{ type: 'text', text: 'ok' }] } }),
]

describe('LiveProjector 的切段', () => {
  test('一条消息一段起；正文之后的工具另起一段，紧挨着的几次调用同段；下一条消息再起一段', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: '改一下' }),
      ...message(p),
      ...p.thinkingDelta('先看看', 0),
      ...p.textDelta('我去改', 1),
      ...edit(p, 'c1'),
      ...edit(p, 'c2'),
      ...message(p),
      ...p.thinkingDelta('改好了吗', 0),
    ])

    expect(layout(state)).toEqual([['t1.a0.c0', 't1.a0.c1'], ['tool.c1', 'tool.c2'], ['t1.a1.c0']])
    expect(turnOf(state).steps.map((step) => step.state)).toEqual(['completed', 'completed', 'running'])
  })

  test('一块都不上屏的消息不占段，段号不跳', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: 'q' }),
      ...message(p),
      ...p.textDelta('一', 0),
      ...message(p),
      ...message(p),
      ...p.textDelta('二', 0),
    ])

    expect(turnOf(state).steps.map((step) => step.stepId)).toEqual(['t1.0', 't1.1'])
  })

  test('参数先流的工具：开跑与收尾都写回参数占住的那一段，屏幕上只有一张卡片', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: 'q' }),
      ...message(p),
      ...p.textDelta('画个界面', 0),
      ...p.toolInput({ toolCallId: 'ui', toolName: 'intelligent_ui', args: { html: '<p>' }, final: true }),
      ...edit(p, 'ui'),
    ])

    expect(layout(state)).toEqual([['t1.a0.c0'], ['tool.ui']])
  })

  test('工具在下一条消息开始之后才收尾：仍写回它开跑的那一段', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: 'q' }),
      ...message(p),
      ...p.textDelta('后台跑着', 0),
      ...p.toolStart({ toolCallId: 'bg', toolName: 'bash', args: {} }),
      ...message(p),
      ...p.textDelta('接着说', 0),
      ...p.toolEnd({ toolCallId: 'bg', toolName: 'bash', result: 'done' }),
    ])

    expect(layout(state)).toEqual([['t1.a0.c0'], ['tool.bg'], ['t1.a1.c0']])
  })

  test('插话自占一段，之后的产出另起一段', () => {
    const p = projector()
    const state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: 'q' }),
      ...message(p),
      ...p.textDelta('先做', 0),
      ...p.steeredFrame('改这里'),
      ...message(p),
      ...p.textDelta('好', 0),
    ])

    expect(layout(state)).toEqual([['t1.a0.c0'], ['t1.u1'], ['t1.a1.c0']])
  })

  test('思考流式：已落定的段保持同一个对象（投影层据此复用，工具卡片不重算）', () => {
    const p = projector()
    let state = applyOps(emptyTimeline(), [
      ...p.userTurn({ text: 'q' }),
      ...message(p),
      ...p.textDelta('我去改', 0),
      ...edit(p, 'c1'),
      ...message(p),
      ...p.thinkingDelta('想', 0),
    ])
    const [first, tools] = turnOf(state).steps

    for (const chunk of ['一', '想', '再', '改']) {
      state = applyOps(state, p.thinkingDelta(chunk, 0))
      const steps = turnOf(state).steps
      expect(steps[0]).toBe(first)
      expect(steps[1]).toBe(tools)
    }
    expect(turnOf(state).steps.at(-1)?.frames[0]).toMatchObject({ kind: 'thinking', text: '想一想再改' })
  })
})
