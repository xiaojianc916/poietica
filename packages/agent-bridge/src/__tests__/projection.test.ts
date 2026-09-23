/*
 * 投影器的自检：喂进一串事件，把吐出的 ops 按 ops/apply.ts 的规矩落一遍。
 *
 * 这里不重抄 appendAtOffset 的判据，而是直接用它 —— 投影错了（offset 接不上）
 * apply 会报 gap，测试就红。
 */

import { describe, expect, it } from 'bun:test'

import { applyOperation, EMPTY_AGENT_STATE } from '@poietica/transcript'

import { TranscriptProjector } from '../projection.ts'

type Op = ReturnType<TranscriptProjector['turnEnd']>[number]

/** 把一串 op 落到状态上，返回 (状态, 有无 gap)。 */
function settle(ops: readonly Op[]) {
  let state = EMPTY_AGENT_STATE
  let gapped = false

  for (const op of ops) {
    const result = applyOperation(state, op)
    if (result.gap !== undefined) {
      gapped = true
    }
    state = result.state
  }

  const turn = (id: string) => {
    const item = state.items.find((entry) => entry.kind === 'turn' && entry.turnId === id)
    return item?.kind === 'turn' ? item : undefined
  }

  return { state, gapped, turn }
}

describe('omp 事件投影成 transcript ops', () => {
  it('一轮正文流式追加：offset 逐条接得上，apply 不报 gap', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('读一下 README')]

    for (const chunk of ['你', '好', '，世界']) {
      ops.push(...projector.textDelta(chunk))
    }

    const { gapped, turn } = settle(ops)
    expect(gapped).toBe(false)

    expect(turn('t1')?.prompt).toBe('读一下 README')

    const assistant = turn('t1')?.steps[0]?.frames.find(
      (frame) => frame.kind === 'text' && frame.role === 'assistant',
    )
    expect(assistant).toMatchObject({ kind: 'text', text: '你好，世界' })
  })

  it('工具调用同 id 覆盖：从 running 走到 done，不是两帧', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('跑一下')]

    ops.push(
      ...projector.toolStart({ toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
    )
    ops.push(...projector.toolEnd({ toolCallId: 'c1', toolName: 'bash', result: 'a.ts\nb.ts' }))

    const { turn } = settle(ops)
    const tools = (turn('t1')?.steps[0]?.frames ?? []).filter((frame) => frame.kind === 'tool')

    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'tool', toolCallId: 'c1', state: 'done' })
  })

  it('失败的工具调用落 error，并把结果写进 error 文案', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('跑一下')]

    ops.push(...projector.toolStart({ toolCallId: 'c9', toolName: 'bash', args: {} }))
    ops.push(
      ...projector.toolEnd({
        toolCallId: 'c9',
        toolName: 'bash',
        result: 'boom',
        isError: true,
      }),
    )

    const { turn } = settle(ops)
    const tool = (turn('t1')?.steps[0]?.frames ?? []).find((frame) => frame.kind === 'tool')

    expect(tool).toMatchObject({ kind: 'tool', state: 'error', error: 'boom' })
  })

  it('正文与思维链各占一帧：换流不会把两种字混进同一帧', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('想一下')]

    ops.push(...projector.thinkingDelta('先看'))
    ops.push(...projector.textDelta('答案'))

    const { gapped, turn } = settle(ops)
    expect(gapped).toBe(false)

    const frames = turn('t1')?.steps[0]?.frames ?? []
    const thinking = frames.find((frame) => frame.kind === 'thinking')
    const assistant = frames.find((frame) => frame.kind === 'text' && frame.role === 'assistant')

    expect(thinking).toMatchObject({ kind: 'thinking', text: '先看' })
    expect(assistant).toMatchObject({ kind: 'text', text: '答案' })
  })

  it('轮终把 turn 与 step 一起收掉，并把相位打回 idle', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('做点事')]
    ops.push(...projector.textDelta('做完了'))
    ops.push(...projector.turnEnd('completed'))

    const { state, turn } = settle(ops)

    expect(turn('t1')?.state).toBe('completed')
    expect(turn('t1')?.steps[0]?.state).toBe('completed')
    expect(state.meta.activity).toBe('idle')
  })

  it('取消与失败落各自的状态，不是都叫 completed', () => {
    for (const [outcome, expected, stepState] of [
      ['cancelled', 'cancelled', 'interrupted'],
      ['failed', 'failed', 'failed'],
    ] as const) {
      const projector = new TranscriptProjector()
      const ops: Op[] = [...projector.userTurn('做点事')]
      ops.push(...projector.turnEnd(outcome))

      const { turn } = settle(ops)
      expect(turn('t1')?.state).toBe(expected)
      expect(turn('t1')?.steps[0]?.state).toBe(stepState)
    }
  })

  it('没有开轮时来的增量被丢掉，不凭空造 turn', () => {
    const projector = new TranscriptProjector()

    expect(projector.textDelta('孤儿')).toEqual([])
    expect(projector.toolStart({ toolCallId: 'x', toolName: 'bash', args: {} })).toEqual([])
    expect(projector.turnEnd('completed')).toEqual([])
  })

  it('第二条用户消息开第二个 turn，编号递增', () => {
    const projector = new TranscriptProjector()
    const ops: Op[] = [...projector.userTurn('第一句')]
    ops.push(...projector.turnEnd('completed'))
    ops.push(...projector.userTurn('第二句'))

    const { gapped, turn } = settle(ops)
    expect(gapped).toBe(false)
    expect(turn('t1')?.prompt).toBe('第一句')
    expect(turn('t2')?.prompt).toBe('第二句')
  })
})
