import { describe, expect, test } from 'bun:test'
import { applyOps, emptyTimeline, type TranscriptFrame, type TranscriptOperation } from '@poietica/transcript'
import { LiveProjector, TOOL_INPUT_INTERVAL_MS, TOOL_INPUT_MAX_WAIT_MS, TOOL_INPUT_MIN_GROWTH_BYTES } from '../live'
import { framesOf, T0 } from './fixtures/live'

/*
 * 参数流式上屏（EngineToolSpec.streamInput，目前只有 intelligent_ui）：toolcall_* 增量经 toolInput 先占住
 * 那一格（inputPending），toolStart 同号接手；节流、去重、轮终收口、迟到的增量都在这里钉住。
 */

function rig() {
  let at = T0
  const p = new LiveProjector({ now: () => at })
  p.userTurn({ text: 'q' })
  return {
    p,
    advance: (ms: number) => {
      at += ms
    },
    input: (args: unknown, final = false) => p.toolInput({ toolCallId: 'c1', toolName: 'intelligent_ui', args, final }),
  }
}

function toolFrames(ops: readonly TranscriptOperation[]): Extract<TranscriptFrame, { kind: 'tool' }>[] {
  return framesOf(applyOps(emptyTimeline(), ops)).filter(
    (frame): frame is Extract<TranscriptFrame, { kind: 'tool' }> => frame.kind === 'tool',
  )
}

describe('LiveProjector · 参数流式上屏', () => {
  test('I1 第一份就占住那一格：running + inputPending，帧号与 toolStart 同号', () => {
    const r = rig()
    const ops = r.input({ title: 'A' })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      op: 'frame.upsert',
      frame: {
        kind: 'tool',
        frameId: 'tool.c1',
        toolCallId: 'c1',
        name: 'intelligent_ui',
        state: 'running',
        inputPending: true,
      },
    })
  })

  test('I2 双门限：250ms 内不发；到点但增长不足也不发；增长够才发；final 不受门限、只去重', () => {
    const r = rig()
    const big = 'x'.repeat(TOOL_INPUT_MIN_GROWTH_BYTES)
    r.input({ html: '<p' })
    r.advance(TOOL_INPUT_INTERVAL_MS - 1)
    expect(r.input({ html: '<p>a' })).toEqual([])
    /* 250ms 到点是下界，不是必发点：小增量先攒着，md 的「入参变了才发」仍成立，只是中间帧更少 */
    r.advance(1)
    expect(r.input({ html: '<p>a' })).toEqual([])
    r.advance(TOOL_INPUT_INTERVAL_MS)
    expect(r.input({ html: `<p>a${big}` })).toHaveLength(1)
    r.advance(TOOL_INPUT_INTERVAL_MS)
    expect(r.input({ html: `<p>a${big}` })).toEqual([])
    r.advance(10)
    const final = r.input({ html: `<p>a${big}ab</p>` }, true)
    expect(final).toHaveLength(1)
    expect(toolFrames(final)[0]?.input).toEqual({ html: `<p>a${big}ab</p>` })
    expect(r.input({ html: `<p>a${big}ab</p>` }, true)).toEqual([])
  })

  test('I2b 小步增长不会饿死预览：到检查点时距上次发出满最长等待，仍会发一帧', () => {
    const r = rig()
    r.input({ html: '<p>' })
    r.advance(TOOL_INPUT_INTERVAL_MS)
    expect(r.input({ html: '<p>a' })).toEqual([])
    r.advance(TOOL_INPUT_MAX_WAIT_MS - TOOL_INPUT_INTERVAL_MS)
    expect(r.input({ html: '<p>ab' })).toHaveLength(1)
  })

  test('I3 toolStart 同号接手、去掉 inputPending；之后迟到的增量一律不理', () => {
    const r = rig()
    const ops = [...r.input({ html: '<p>' })]
    ops.push(...r.p.toolStart({ toolCallId: 'c1', toolName: 'intelligent_ui', args: { html: '<p>x</p>' } }))
    r.advance(TOOL_INPUT_INTERVAL_MS * 2)
    expect(r.input({ html: '<p>x</p>' }, true)).toEqual([])
    ops.push(...r.p.toolEnd({ toolCallId: 'c1', toolName: 'intelligent_ui', result: 'ok' }))
    r.advance(TOOL_INPUT_INTERVAL_MS * 2)
    expect(r.input({ html: 'late' })).toEqual([])
    const frames = toolFrames(ops)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.state).toBe('done')
    expect(frames[0]?.inputPending).toBeUndefined()
    expect(frames[0]?.input).toEqual({ html: '<p>x</p>' })
  })

  test('I4 轮终时还没开始跑的：按最新那份入参（含节流掉的）收成普通 running', () => {
    const r = rig()
    const ops = [...r.input({ html: '<p>' })]
    r.advance(1)
    ops.push(...r.input({ html: '<p>half' }))
    ops.push(...r.p.turnEnd('cancelled', null))
    const frames = toolFrames(ops)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.state).toBe('running')
    expect(frames[0]?.inputPending).toBeUndefined()
    expect(frames[0]?.input).toEqual({ html: '<p>half' })
    expect(r.input({ html: 'after' })).toEqual([])
  })

  test('I2c 250ms 是硬下界：再大的增长也要等到下界；final 不受下界约束', () => {
    const r = rig()
    r.input({ html: '<' })
    const grown = 'x'.repeat(TOOL_INPUT_MIN_GROWTH_BYTES * 2)
    r.advance(TOOL_INPUT_INTERVAL_MS - 1)
    expect(r.input({ html: `<${grown}` })).toEqual([])
    r.advance(1)
    expect(r.input({ html: `<${grown}>` })).toHaveLength(1)
    r.advance(1)
    expect(r.input({ html: `<${grown}>!</p>` }, true)).toHaveLength(1)
  })

  test('I5 没开轮次不发；放弃这一轮之后不再收口', () => {
    const idle = new LiveProjector({ now: () => T0 })
    expect(idle.toolInput({ toolCallId: 'c1', toolName: 't', args: {}, final: false })).toEqual([])
    const r = rig()
    r.input({ html: '<p>' })
    r.p.abandonTurn()
    expect(r.p.turnEnd('completed', null)).toEqual([])
  })

  test('I6 参数那一格之后的正文另起一帧', () => {
    const r = rig()
    const ops = [...r.p.textDelta('先说一句'), ...r.input({ html: '<p>' }), ...r.p.textDelta('再说一句')]
    const frames = framesOf(applyOps(emptyTimeline(), ops))
    expect(frames.map((frame) => frame.kind)).toEqual(['text', 'tool', 'text'])
  })

  test('I7 几十 KB 连续 delta：帧数与总字节远小于逐 delta 一帧，轮终 settleInputs 带最新完整 args', () => {
    const r = rig()
    const chunk = 'x'.repeat(512)
    const ops: TranscriptOperation[] = []
    const totalDeltas = 200
    let html = ''
    let naiveBytes = 0
    for (let index = 0; index < totalDeltas; index += 1) {
      html += chunk
      /* 每 8 条 delta 才推进一个 250ms：模拟模型持续写、投影按时间窗合并 */
      if (index > 0 && index % 8 === 0) r.advance(TOOL_INPUT_INTERVAL_MS)
      ops.push(...r.input({ html }))
      naiveBytes += JSON.stringify({ html }).length
    }
    const latest = { html }
    ops.push(...r.p.turnEnd('cancelled', null))

    const emitted = ops.filter((op) => op.op === 'frame.upsert' && op.frame.kind === 'tool')
    const sentBytes = emitted.reduce(
      (sum, op) =>
        sum + (op.op === 'frame.upsert' && op.frame.kind === 'tool' ? JSON.stringify(op.frame.input).length : 0),
      0,
    )
    expect(html.length).toBeGreaterThanOrEqual(TOOL_INPUT_MIN_GROWTH_BYTES * 6)
    /* 200 条 delta 至少要按 250ms 时间窗合并成 O(时间) 帧，而不是 O(delta) 帧 */
    expect(emitted.length).toBeLessThanOrEqual(Math.ceil(totalDeltas / 8) + 1)
    expect(sentBytes).toBeLessThan(naiveBytes / 4)

    const frames = toolFrames(ops)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.state).toBe('running')
    expect(frames[0]?.inputPending).toBeUndefined()
    expect(frames[0]?.input).toEqual(latest)
  })
})
